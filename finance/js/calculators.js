import { state } from './state.js';
import { getCategoryParent, LEGACY_CATEGORY_MAP } from './categories.js';

export function normalizeCat(cat) {
    if (!cat) return 'Uncategorized';
    if (cat.includes(' > ')) return cat;
    return LEGACY_CATEGORY_MAP[cat] ?? cat;
}

export function filterTransactions(transactions, filters) {
    if (!Array.isArray(transactions)) return [];
    let filtered = transactions;

    if (filters.dateRange && filters.dateRange !== 'all') {
        const now = new Date();
        let cutoff;

        if (filters.dateRange === 'this-month') {
            cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
        } else if (filters.dateRange === 'last-month') {
            cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const end = new Date(now.getFullYear(), now.getMonth(), 1);
            filtered = filtered.filter(t => {
                const d = new Date(t.date);
                return d >= cutoff && d < end;
            });
            if (filters.category !== 'all') {
                filtered = filtered.filter(t => {
                    const norm = normalizeCat(t.category);
                    return norm === filters.category || getCategoryParent(norm) === filters.category;
                });
            }
            return filtered;
        } else if (filters.dateRange === 'ytd') {
            cutoff = new Date(now.getFullYear(), 0, 1);
        } else {
            const days = parseInt(filters.dateRange, 10);
            cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
        }

        filtered = filtered.filter(t => new Date(t.date) >= cutoff);
    }

    if (filters.category && filters.category !== 'all') {
        filtered = filtered.filter(t => {
            const norm = normalizeCat(t.category);
            return norm === filters.category || getCategoryParent(norm) === filters.category;
        });
    }

    if (filters.confidence && filters.confidence === 'low') {
        filtered = filtered.filter(t => typeof t.confidence === 'number' && t.confidence < 0.75);
    }

    if (filters.tag && filters.tag !== 'all') {
        filtered = filtered.filter(t => {
            const tags = Array.isArray(t.tags) ? t.tags : [];
            return tags.includes(filters.tag);
        });
    }

    return filtered;
}

export function calculateCashFlow(personalExpensesRaw) {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const netPersonalMonthly = ((state.income / 12) * (1 - taxRate)) + state.taxFreeIncome;
    const freeCashFlow = netPersonalMonthly - personalExpensesRaw;
    return {
        netPersonalMonthly,
        freeCashFlow,
        totalSpend: personalExpensesRaw,
    };
}

export function calculateHousingMatrix(targetPrice, downPct, rate, loanType, isVaTaxExempt = false) {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const effectiveMonthlyGross = (state.income / 12) + (state.taxFreeIncome / (1 - taxRate));
    const personalMax = effectiveMonthlyGross * 0.28;

    const r = rate / 100 / 12;
    const n = 360;
    const loanAmt = targetPrice * (1 - (downPct / 100));
    let pmt = 0;
    if (loanAmt > 0) pmt = (r === 0) ? (loanAmt / n) : (loanAmt * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));

    const monthlyPropTax = isVaTaxExempt ? 0 : (targetPrice * 0.012) / 12;
    const monthlyIns = (targetPrice * 0.005) / 12;
    let pmi = 0;
    if (loanType === 'va') {
        pmi = 0;
    } else if (loanType === 'fha' && downPct < 20) {
        pmi = (loanAmt * 0.0085) / 12;
    } else if (loanType === 'conv' && downPct < 20) {
        pmi = (loanAmt * 0.005) / 12;
    }

    const actualPayment = pmt + monthlyPropTax + monthlyIns + pmi;

    let amortizationFactor = (r === 0) ? (1 / n) : ((r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
    let pmiFactor = loanType === 'va' ? 0 : loanType === 'fha' ? 0.0085 / 12 : 0.005 / 12;

    const combinedFactor = ((1 - (downPct / 100)) * amortizationFactor)
        + (isVaTaxExempt ? 0 : (0.012 / 12))
        + (0.005 / 12)
        + ((1 - (downPct / 100)) * (pmi > 0 ? pmiFactor : 0));
    const maxPurchase = combinedFactor > 0 ? personalMax / combinedFactor : 0;

    return { personalMax, actualPayment, maxPurchase };
}

export function calculateAutoMatrix(targetPrice, term, rate) {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const effectiveMonthlyGross = (state.income / 12) + (state.taxFreeIncome / (1 - taxRate));
    const personalMax = effectiveMonthlyGross * 0.10;

    const r = rate / 100 / 12;
    let pmt = 0;
    if (targetPrice > 0) pmt = (r === 0) ? (targetPrice / term) : (targetPrice * (r * Math.pow(1 + r, term)) / (Math.pow(1 + r, term) - 1));

    const maxPurchase = (r === 0) ? (personalMax * term) : (personalMax * ((1 - Math.pow(1 + r, -term)) / r));
    return { personalMax, actualPayment: pmt, maxPurchase };
}

export function calculateFIRE(contribution, returnRate, inflation) {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const effectiveMonthlyGross = (state.income / 12) + (state.taxFreeIncome / (1 - taxRate));
    const annualExpenses = effectiveMonthlyGross * 0.6 * 12;
    const fiNumber = annualExpenses * 25;
    const realReturn = (returnRate - inflation) / 100;
    let port = state.portfolio;
    let age = state.age;
    const ages = [age];
    const balances = [port];

    while (port < fiNumber && age < 100) {
        port = port * (1 + realReturn) + (contribution * 12);
        age++;
        ages.push(age);
        balances.push(port);
    }
    return { fiNumber, ages, balances, finalAge: port >= fiNumber ? age : '100+' };
}

export function groupTransactionsByMonth(transactions) {
    const grouped = {};
    if (!Array.isArray(transactions)) return grouped;

    transactions.forEach(t => {
        const rawDate = typeof t.date === 'string' ? t.date : '';
        const month = rawDate.length >= 7 ? rawDate.substring(0, 7) : 'Unknown';
        if (!grouped[month]) grouped[month] = { inflow: 0, outflow: 0, items: [] };
        const amount = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amount > 0;
        if (isIncome) grouped[month].inflow += Math.abs(amount);
        else grouped[month].outflow += Math.abs(amount);
        grouped[month].items.push(t);
    });
    return grouped;
}

export function groupTransactionsByCategory(transactions) {
    const grouped = {};
    if (!Array.isArray(transactions)) return grouped;

    transactions.forEach(t => {
        const amount = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amount > 0;
        if (isIncome) return;
        const cat = normalizeCat(t.category);
        const parent = getCategoryParent(cat);
        if (!grouped[parent]) grouped[parent] = { total: 0, items: [], subcategories: {} };
        grouped[parent].total += Math.abs(amount);
        grouped[parent].items.push(t);
        if (!grouped[parent].subcategories[cat]) grouped[parent].subcategories[cat] = 0;
        grouped[parent].subcategories[cat] += Math.abs(amount);
    });
    return grouped;
}

export function groupTransactionsByMerchant(transactions) {
    const grouped = {};
    if (!Array.isArray(transactions)) return grouped;

    transactions.forEach(t => {
        const amount = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amount > 0;
        if (isIncome) return;
        const merchant = (t.clean_merchant || t.description || 'Unknown').trim();
        if (!grouped[merchant]) grouped[merchant] = { total: 0, items: [] };
        grouped[merchant].total += Math.abs(amount);
        grouped[merchant].items.push(t);
    });
    return grouped;
}

export function groupTransactionsByCategoryAndMonth(transactions) {
    const result = {};
    if (!Array.isArray(transactions)) return result;

    transactions.forEach(t => {
        const amount = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amount > 0;
        if (isIncome) return;

        const rawDate = typeof t.date === 'string' ? t.date : '';
        const month = rawDate.length >= 7 ? rawDate.substring(0, 7) : 'Unknown';
        const parent = getCategoryParent(normalizeCat(t.category));

        if (!result[parent]) result[parent] = {};
        if (!result[parent][month]) result[parent][month] = 0;
        result[parent][month] += Math.abs(amount);
    });
    return result;
}

export function calculateSpendingPace(transactions) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();

    const mtdSpend = transactions
        .filter(t => {
            const d = new Date(t.date);
            return d >= monthStart && (t.type === 'expense' || Number(t.amount) < 0);
        })
        .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);

    const dailyRate = daysElapsed > 0 ? mtdSpend / daysElapsed : 0;
    const projectedTotal = dailyRate * daysInMonth;

    return { mtdSpend, dailyRate, projectedTotal, daysElapsed, daysInMonth };
}

export function calculateRollingAverage(monthlyTotals, window = 3) {
    return monthlyTotals.map((_, i) => {
        const slice = monthlyTotals.slice(Math.max(0, i - window + 1), i + 1);
        return slice.reduce((s, v) => s + v, 0) / slice.length;
    });
}

export function getPercentile(data, ht, sx, ed, rc, income) {
    const brackets = data?.demographics?.[ht]?.[sx]?.[ed]?.[rc];
    if (!Array.isArray(brackets) || brackets.length === 0) return null;
    const idx = brackets.findIndex(b => b.income >= income);
    if (idx === -1) return 1;
    if (idx === 0 && income < brackets[0].income) return 99;
    return Math.max(1, 100 - brackets[idx].percentile);
}

export function getPreProcessingSummary(filteredTransactions) {
    let totalIncome = 0;
    let totalSpend = 0;
    const catMap = {};
    const merchMap = {};

    filteredTransactions.forEach(t => {
        const amt = Math.abs(Number(t.amount) || 0);
        const isIncome = t.type === 'income' || Number(t.amount) > 0;

        if (isIncome) {
            totalIncome += amt;
        } else {
            totalSpend += amt;
            const cat = normalizeCat(t.category);
            const parent = getCategoryParent(cat);
            catMap[parent] = (catMap[parent] || 0) + amt;
            const merch = (t.clean_merchant || t.description || 'Unknown').trim();
            merchMap[merch] = (merchMap[merch] || 0) + amt;
        }
    });

    const topMerchants = Object.entries(merchMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(x => ({ name: x[0], amount: x[1] }));

    return { totalIncome, totalSpend, categoryBreakdown: catMap, topMerchants };
}

export function calculateBudgetStatus(transactions, budgetLimits) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = Math.max(1, now.getDate());

    const actualByCategory = {};
    transactions.forEach(t => {
        const d = new Date(t.date);
        if (d < monthStart) return;
        const amt = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amt > 0;
        if (isIncome) return;
        const parent = getCategoryParent(normalizeCat(t.category));
        actualByCategory[parent] = (actualByCategory[parent] || 0) + Math.abs(amt);
    });

    const allCategories = new Set([
        ...Object.keys(budgetLimits),
        ...Object.keys(actualByCategory)
    ]);

    const results = [];
    allCategories.forEach(cat => {
        const actual = actualByCategory[cat] || 0;
        const limit = budgetLimits[cat] || 0;
        const remaining = Math.max(0, limit - actual);
        const percentUsed = limit > 0 ? Math.min(100, (actual / limit) * 100) : (actual > 0 ? 100 : 0);
        const projectedMonthEnd = (actual / daysElapsed) * daysInMonth;
        const isOverBudget = limit > 0 && actual > limit;
        const isNearBudget = limit > 0 && percentUsed >= 80 && !isOverBudget;

        results.push({ cat, actual, limit, remaining, percentUsed, projectedMonthEnd, isOverBudget, isNearBudget });
    });

    results.sort((a, b) => {
        if (a.isOverBudget && !b.isOverBudget) return -1;
        if (!a.isOverBudget && b.isOverBudget) return 1;
        if (a.isNearBudget && !b.isNearBudget) return -1;
        if (!a.isNearBudget && b.isNearBudget) return 1;
        return b.actual - a.actual;
    });

    return { results, daysElapsed, daysInMonth };
}
