import { state } from './state.js';

export function calculateCashFlow(personalExpensesRaw) {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const netPersonalMonthly = (state.income / 12) * (1 - taxRate);
    const freeCashFlow = netPersonalMonthly - personalExpensesRaw - state.sharedContribution;
    return {
        netPersonalMonthly,
        freeCashFlow,
        personalDiscretionary: personalExpensesRaw,
        sharedObligation: state.sharedContribution
    };
}

export function calculateHousingMatrix(spouseContrib, targetPrice, downPct, rate, loanType) {
    const personalMax = (state.income / 12) * 0.28;
    const combinedMax = personalMax + spouseContrib;
    
    const r = rate / 100 / 12;
    const n = 360;
    const loanAmt = targetPrice * (1 - (downPct/100));
    let pmt = 0;
    if (loanAmt > 0) pmt = (r === 0) ? (loanAmt / n) : (loanAmt * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
    
    const monthlyPropTax = (targetPrice * 0.012) / 12;
    const monthlyIns = (targetPrice * 0.005) / 12;
    let pmi = 0;
    if (loanType === 'fha' && downPct < 20) pmi = (loanAmt * 0.0085) / 12;
    else if (loanType === 'conv' && downPct < 20) pmi = (loanAmt * 0.005) / 12;
    
    const actualPayment = pmt + monthlyPropTax + monthlyIns + pmi;
    
    let amortizationFactor = (r === 0) ? (1 / n) : ((r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
    const combinedFactor = ((1 - (downPct/100)) * amortizationFactor) + (0.012/12) + (0.005/12) + ((1 - (downPct/100)) * (pmi > 0 ? (loanType==='fha'?0.0085/12:0.005/12) : 0));
    const maxPurchase = combinedFactor > 0 ? combinedMax / combinedFactor : 0;

    return { combinedMax, actualPayment, maxPurchase };
}

export function calculateAutoMatrix(spouseContrib, targetPrice, term, rate) {
    const personalMax = (state.income / 12) * 0.10;
    const combinedMax = personalMax + spouseContrib;
    
    const r = rate / 100 / 12;
    let pmt = 0;
    if (targetPrice > 0) pmt = (r === 0) ? (targetPrice / term) : (targetPrice * (r * Math.pow(1 + r, term)) / (Math.pow(1 + r, term) - 1));
    
    const maxPurchase = (r === 0) ? (combinedMax * term) : (combinedMax * ((1 - Math.pow(1 + r, -term)) / r));
    return { combinedMax, actualPayment: pmt, maxPurchase };
}

export function calculateFIRE(contribution, returnRate, inflation) {
    const annualExpenses = (state.sharedContribution * 12) + ((state.income / 12) * 0.5 * 12);
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
    transactions.forEach(t => {
        const month = t.date.substring(0, 7);
        if (!grouped[month]) grouped[month] = { inflow: 0, outflow: 0, items:[] };
        if (t.amount > 0) grouped[month].inflow += t.amount;
        else grouped[month].outflow += Math.abs(t.amount);
        grouped[month].items.push(t);
    });
    return grouped;
}

export function getPercentile(data, ht, sx, ed, rc, income) {
    const brackets = data?.demographics?.[ht]?.[sx]?.[ed]?.[rc];
    if (!Array.isArray(brackets) || brackets.length === 0) return null;
    const idx = brackets.findIndex(b => b.income >= income);
    if (idx === -1) return 1;
    if (idx === 0 && income < brackets[0].income) return 99;
    return Math.max(1, 100 - brackets[idx].percentile);
}