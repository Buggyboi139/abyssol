import { state } from './state.js';
import { fetchLocationData, saveUserProfile, listStatements, saveBudgetLimit, updateTransactionTags } from './api.js';
import { calculateCashFlow, calculateHousingMatrix, calculateAutoMatrix, calculateFIRE, groupTransactionsByMonth, getPercentile, groupTransactionsByCategory, filterTransactions, groupTransactionsByMerchant, normalizeCat, calculateBudgetStatus, calculateRollingAverage } from './calculators.js';
import { drawHistoryChart, drawDonutChart, drawFireChart, drawBellCurve, drawCategoryDonutChart, drawMerchantChart, drawBudgetBarsChart } from './charts.js';
import { CATEGORY_TAXONOMY, FLAT_CATEGORIES, PARENT_CATEGORIES, getCategoryColor, getCategoryParent } from './categories.js';

function fmt(amt) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amt || 0);
}

function debounce(fn, wait) {
    let timeoutId = null;
    return function debounced(...args) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), wait);
    };
}

const debouncedSaveProfile = debounce((userId, payload) => {
    saveUserProfile(userId, payload);
}, 700);

export function buildCategorySelectHTML(selectedValue = 'Uncategorized', includeAll = false) {
    let html = includeAll ? '<option value="all">All Categories</option>' : '';
    for (const [parent, subs] of Object.entries(CATEGORY_TAXONOMY)) {
        if (subs.length === 0) {
            html += `<option value="${parent}" ${selectedValue === parent ? 'selected' : ''}>${parent}</option>`;
        } else {
            html += `<optgroup label="${parent}">`;
            subs.forEach(sub => {
                const full = `${parent} > ${sub}`;
                html += `<option value="${full}" ${selectedValue === full ? 'selected' : ''}>${sub}</option>`;
            });
            html += `</optgroup>`;
        }
    }
    return html;
}

export function hydrateUI(profile) {
    state.income = Number(profile.income) || 0;
    state.taxFreeIncome = Number(profile.tax_free_income) || 0;
    state.portfolio = Number(profile.portfolio) || 0;
    state.creditScore = Number(profile.credit_score) || 720;
    state.age = Number(profile.age) || 25;
    state.location = profile.location || 'national';
    state.householdType = profile.household_type || 'all';
    state.sex = profile.sex || 'all';
    state.education = profile.education || 'all';
    state.race = profile.race || 'all';

    if (document.getElementById('baseIncome')) document.getElementById('baseIncome').value = state.income || '';
    if (document.getElementById('taxFreeIncome')) document.getElementById('taxFreeIncome').value = state.taxFreeIncome || '';
    if (document.getElementById('currentPortfolio')) document.getElementById('currentPortfolio').value = state.portfolio || '';
    if (document.getElementById('creditScore')) document.getElementById('creditScore').value = state.creditScore;
    if (document.getElementById('age')) document.getElementById('age').value = state.age;
    if (document.getElementById('location')) document.getElementById('location').value = state.location;
    if (document.getElementById('householdType')) document.getElementById('householdType').value = state.householdType;
    if (document.getElementById('sex')) document.getElementById('sex').value = state.sex;
    if (document.getElementById('education')) document.getElementById('education').value = state.education;
    if (document.getElementById('race')) document.getElementById('race').value = state.race;
    state.liabilities.creditCardDebt = Number(profile.liab_credit_card) || 0;
    state.liabilities.studentLoans = Number(profile.liab_student_loans) || 0;
    state.liabilities.carLoanBalance = Number(profile.liab_car_loan) || 0;
    state.liabilities.otherDebt = Number(profile.liab_other) || 0;
    const totalLiab = Object.values(state.liabilities).reduce((s, v) => s + v, 0);
    state.netWorth = state.portfolio - totalLiab;
    if (document.getElementById('liabCreditCard')) document.getElementById('liabCreditCard').value = state.liabilities.creditCardDebt || '';
    if (document.getElementById('liabStudentLoans')) document.getElementById('liabStudentLoans').value = state.liabilities.studentLoans || '';
    if (document.getElementById('liabCarLoan')) document.getElementById('liabCarLoan').value = state.liabilities.carLoanBalance || '';
    if (document.getElementById('liabOther')) document.getElementById('liabOther').value = state.liabilities.otherDebt || '';
}

function readStateFromDom() {
    state.income = parseFloat(document.getElementById('baseIncome')?.value) || 0;
    state.taxFreeIncome = parseFloat(document.getElementById('taxFreeIncome')?.value) || 0;
    state.portfolio = parseFloat(document.getElementById('currentPortfolio')?.value) || 0;
    state.creditScore = parseFloat(document.getElementById('creditScore')?.value) || 720;
    state.age = parseInt(document.getElementById('age')?.value, 10) || 25;
    state.location = document.getElementById('location')?.value || 'national';
    state.householdType = document.getElementById('householdType')?.value || 'all';
    state.sex = document.getElementById('sex')?.value || 'all';
    state.education = document.getElementById('education')?.value || 'all';
    state.race = document.getElementById('race')?.value || 'all';
    state.liabilities.creditCardDebt = parseFloat(document.getElementById('liabCreditCard')?.value) || 0;
    state.liabilities.studentLoans = parseFloat(document.getElementById('liabStudentLoans')?.value) || 0;
    state.liabilities.carLoanBalance = parseFloat(document.getElementById('liabCarLoan')?.value) || 0;
    state.liabilities.otherDebt = parseFloat(document.getElementById('liabOther')?.value) || 0;
    const totalLiabilities = Object.values(state.liabilities).reduce((s, v) => s + v, 0);
    state.netWorth = state.portfolio - totalLiabilities;
}

function buildProfilePayload() {
    return {
        income: state.income,
        tax_free_income: state.taxFreeIncome,
        portfolio: state.portfolio,
        credit_score: state.creditScore,
        age: state.age,
        location: state.location,
        household_type: state.householdType,
        sex: state.sex,
        education: state.education,
        race: state.race,
        liab_credit_card: state.liabilities.creditCardDebt,
        liab_student_loans: state.liabilities.studentLoans,
        liab_car_loan: state.liabilities.carLoanBalance,
        liab_other: state.liabilities.otherDebt,
    };
}

const locationCache = {};

function populateDateFilter() {
    const select = document.getElementById('filterDateRange');
    if (!select || !state.transactions || state.transactions.length === 0) return;

    const months = new Set();
    state.transactions.forEach(t => {
        if (t.date && t.date.length >= 7) {
            months.add(t.date.substring(0, 7));
        }
    });

    const sortedMonths = Array.from(months).sort().reverse();
    if (sortedMonths.length === 0) return;

    const currentOptions = Array.from(select.options).map(o => o.value);
    const desiredOptions = [...sortedMonths, '90', '180', '365', 'ytd', 'all'];

    if (currentOptions.join(',') !== desiredOptions.join(',')) {
        const formatMonth = (ym) => {
            const [y, m] = ym.split('-');
            const d = new Date(y, parseInt(m) - 1, 1);
            return d.toLocaleString('default', { month: 'long', year: 'numeric' });
        };

        select.innerHTML = sortedMonths.map(ym => `<option value="${ym}">${formatMonth(ym)}</option>`).join('') +
            `<option disabled>──────────</option>
            <option value="90">Last 90 Days</option>
            <option value="180">Last 6 Months</option>
            <option value="365">Last 12 Months</option>
            <option value="ytd">Year to Date</option>
            <option value="all">All Time</option>`;
    }

    let currentFilter = state.filters.dateRange;
    if (!currentFilter || currentFilter === 'this-month' || currentFilter === 'last-month') {
        state.filters.dateRange = sortedMonths[0];
        select.value = sortedMonths[0];
    } else if (select.querySelector(`option[value="${currentFilter}"]`)) {
        select.value = currentFilter;
    } else {
        select.value = sortedMonths[0];
        state.filters.dateRange = sortedMonths[0];
    }
}

export async function triggerCalculations(options = {}) {
    readStateFromDom();

    if (state.location) {
        if (!locationCache[state.location]) {
            locationCache[state.location] = await fetchLocationData(state.location);
        }
        state.locationData = locationCache[state.location];
    }

    const compareEl = document.getElementById('geoCompare');
    const compareLoc = compareEl ? compareEl.value : null;
    if (compareLoc) {
        if (!locationCache[compareLoc]) {
            locationCache[compareLoc] = await fetchLocationData(compareLoc);
        }
        state.compareLocationData = locationCache[compareLoc];
    } else {
        state.compareLocationData = state.locationData;
    }

    if (state.user && !state.isHydrating && !options.skipSave) {
        debouncedSaveProfile(state.user.id, buildProfilePayload());
    }

    populateDateFilter();

    updateOverview();
    updateBudget();
    updatePurchases();
    updateFIRE();
    updateBenchmarking();
    window.dispatchEvent(new CustomEvent('transactionsUpdated'));
}

function confidenceBadge(t) {
    if (typeof t.confidence !== 'number') return '';
    if (t.type === 'income' || Number(t.amount) > 0) return '';
    if (t.confidence >= 0.75) return '';
    const label = t.confidence < 0.5 ? 'Low confidence' : 'Check category';
    const color = t.confidence < 0.5 ? '#fb7185' : '#f59e0b';
    return `<span title="AI confidence: ${Math.round(t.confidence * 100)}%" style="font-size:0.7rem; color:${color}; background:${color}22; padding:2px 7px; border-radius:10px; border:1px solid ${color}44; white-space:nowrap; margin-right:6px;">${label}</span>`;
}

function getAllUserTags() {
    const tagSet = new Set();
    state.transactions.forEach(t => {
        if (Array.isArray(t.tags)) t.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
}

function renderFlatLedger(filteredTransactions) {
    const ledger = document.getElementById('historicalLedger');
    if (!ledger) return;

    if (!filteredTransactions || filteredTransactions.length === 0) {
        ledger.innerHTML = '<div class="item-row no-border-bottom"><span style="color:var(--text-muted)">No transactions match filters.</span></div>';
        return;
    }

    ledger.innerHTML = filteredTransactions.map(t => {
        const amt = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amt > 0;
        const color = isIncome ? '#34d399' : '#f8fafc';
        const prefix = isIncome ? '+' : '';
        const desc = (t.clean_merchant || t.description || t.raw_description || t.category || 'Transaction').toString();
        const bg = isIncome ? 'rgba(52, 211, 153, 0.05)' : 'transparent';
        const currentCat = normalizeCat(t.category);
        const txTags = Array.isArray(t.tags) ? t.tags : [];
        const tagsHTML = `<div class="tx-tags-row" data-id="${t.id}" style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; margin-right:8px;">
    ${txTags.map(tag => `<span class="tag-chip" data-tag="${tag}" data-id="${t.id}" title="Click to remove">${tag} ×</span>`).join('')}
    <button type="button" class="add-tag-btn btn-add-tag" data-id="${t.id}" title="Add tag" style="background:transparent; border:1px dashed rgba(255,255,255,0.2); color:var(--text-muted); border-radius:12px; padding:2px 8px; font-size:0.7rem; cursor:pointer; white-space:nowrap;">+ tag</button>
</div>`;

        return `<div class="item-row" style="align-items:center; background: ${bg}; padding: 12px; border-radius: 8px;">
            <span style="flex:1; display:flex; flex-direction:column; gap:4px;">
                <span style="font-size:0.85rem; color:var(--text-muted);">${t.date || 'Unknown'}</span>
                <span>${desc}</span>
            </span>
            ${!isIncome ? `
            <select class="glass-input btn-small category-select" data-id="${t.id}" style="width:auto; padding:4px 24px 4px 8px; font-size:0.8rem; margin-right:10px; min-width:140px;">
                ${buildCategorySelectHTML(currentCat)}
            </select>
            ` : `<span style="margin-right:10px; font-size:0.8rem; color:#34d399; min-width:120px; display:inline-block; text-align:center;">Income</span>`}
            ${tagsHTML}
            ${confidenceBadge(t)}
            <span style="color:${color}; font-weight:600; width:80px; text-align:right;">${prefix}${fmt(Math.abs(amt))}</span>
            <button class="delete-tx-btn" data-id="${t.id}" title="Delete">🗑️</button>
        </div>`;
    }).join('');
}

function renderRecentActivity() {
    const listEl = document.getElementById('recentActivityList');
    if (!listEl) return;

    const recent = state.transactions.slice(0, 5);
    if (recent.length === 0) {
        listEl.innerHTML = '<span style="color:var(--text-muted); font-size:0.9rem;">No recent transactions.</span>';
        return;
    }

    listEl.innerHTML = recent.map(t => {
        const amt = Number(t.amount) || 0;
        const isIncome = t.type === 'income' || amt > 0;
        const color = isIncome ? '#34d399' : '#fb7185';
        const prefix = isIncome ? '+' : '-';
        const desc = (t.clean_merchant || t.description || 'Transaction').toString();
        return `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border-glass); font-size:0.85rem;">
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:12px;">${desc}</span>
            <span style="color:var(--text-muted); margin-right:12px; flex-shrink:0;">${t.date || ''}</span>
            <span style="color:${color}; font-weight:600; flex-shrink:0;">${prefix}${fmt(Math.abs(amt))}</span>
        </div>`;
    }).join('');
}

function updateOverview() {
    populateDateFilter();
    const filtered = filterTransactions(state.transactions, state.filters);

    let totalIn = 0;
    let totalOut = 0;

    filtered.forEach(t => {
        const amt = Math.abs(Number(t.amount) || 0);
        const isIncome = t.type === 'income' || Number(t.amount) > 0;
        if (isIncome) totalIn += amt;
        else totalOut += amt;
    });

    if (document.getElementById('kpiTotalIncome')) document.getElementById('kpiTotalIncome').textContent = fmt(totalIn);
    if (document.getElementById('kpiTotalSpend')) document.getElementById('kpiTotalSpend').textContent = fmt(totalOut);

    const netFlow = totalIn - totalOut;
    const netEl = document.getElementById('kpiNetCashFlow');
    if (netEl) {
        netEl.textContent = fmt(netFlow);
        netEl.style.color = netFlow < 0 ? '#fb7185' : '#34d399';
    }

    const sr = totalIn > 0 ? (netFlow / totalIn) * 100 : 0;
    if (document.getElementById('kpiSavingsRate')) document.getElementById('kpiSavingsRate').textContent = `${sr.toFixed(1)}%`;

    const nwEl = document.getElementById('kpiNetWorth');
    if (nwEl) {
        nwEl.textContent = fmt(state.netWorth);
        nwEl.style.color = state.netWorth >= 0 ? '#34d399' : '#fb7185';
    }

    renderRecentActivity();
    renderFlatLedger(filtered);

    if (state.activeView === 'timeline') {
        const grouped = groupTransactionsByMonth(filtered);
        const labels = Object.keys(grouped).sort();
        const inflows = labels.map(l => grouped[l].inflow);
        const outflows = labels.map(l => grouped[l].outflow);
        const rollingAvg = calculateRollingAverage(outflows, 3);
        if (typeof drawHistoryChart === 'function') drawHistoryChart(labels, inflows, outflows, rollingAvg);
    } else if (state.activeView === 'category') {
        const grouped = groupTransactionsByCategory(filtered);
        const labels = Object.keys(grouped).sort((a, b) => grouped[b].total - grouped[a].total);
        const totals = labels.map(l => grouped[l].total);
        const colors = labels.map(l => getCategoryColor(l));
        if (typeof drawCategoryDonutChart === 'function') drawCategoryDonutChart(labels, totals, colors);
    } else if (state.activeView === 'merchant') {
        const grouped = groupTransactionsByMerchant(filtered);
        const labels = Object.keys(grouped).sort((a, b) => grouped[b].total - grouped[a].total).slice(0, 10);
        const totals = labels.map(l => grouped[l].total);
        if (typeof drawMerchantChart === 'function') drawMerchantChart(labels, totals);
    }
}

function updateBudget() {
    let activeYYYYMM = state.filters?.dateRange;
    
    if (!activeYYYYMM || !activeYYYYMM.includes('-')) {
        const months = new Set();
        state.transactions.forEach(t => { if (t.date && t.date.length >= 7) months.add(t.date.substring(0, 7)); });
        const sorted = Array.from(months).sort().reverse();
        activeYYYYMM = sorted.length > 0 ? sorted[0] : null;
    }

    let monthName = 'No Data';
    if (activeYYYYMM) {
        const [y, m] = activeYYYYMM.split('-');
        const d = new Date(y, parseInt(m) - 1, 1);
        monthName = d.toLocaleString('default', { month: 'long', year: 'numeric' });
    }

    const monthLabel = document.getElementById('budgetMonthLabel');
    if (monthLabel) monthLabel.textContent = monthName;

    let totalExpThisMonth = 0;
    state.transactions.forEach(t => {
        if (activeYYYYMM && t.date && t.date.startsWith(activeYYYYMM)) {
            if (t.type === 'expense' || Number(t.amount) < 0) {
                totalExpThisMonth += Math.abs(Number(t.amount) || 0);
            }
        }
    });

    const { netPersonalMonthly, freeCashFlow } = calculateCashFlow(totalExpThisMonth);
    const fmt2 = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v || 0);

    if (document.getElementById('budgetTotalSpend')) document.getElementById('budgetTotalSpend').textContent = fmt2(totalExpThisMonth);
    if (document.getElementById('budgetMonthlyIncome')) document.getElementById('budgetMonthlyIncome').textContent = fmt2(netPersonalMonthly);

    const leftOverEl = document.getElementById('budgetLeftOver');
    if (leftOverEl) {
        const lo = netPersonalMonthly - totalExpThisMonth;
        leftOverEl.textContent = fmt2(Math.abs(lo));
        leftOverEl.style.color = lo < 0 ? '#fb7185' : '#34d399';
        leftOverEl.parentElement.querySelector('.gt-label').textContent = lo < 0 ? 'Over Budget' : 'Left Over';
    }

    const { results } = calculateBudgetStatus(state.transactions, state.budgetLimits);
    renderBudgetCategoryRows(results);

    const chartCats = results.map(r => r.cat);
    const chartActuals = results.map(r => r.actual);
    const chartLimits = results.map(r => r.limit);
    if (chartCats.length > 0 && typeof drawBudgetBarsChart === 'function') {
        try { drawBudgetBarsChart(chartCats, chartActuals, chartLimits); } catch (e) { console.error(e); }
    }

    if (typeof drawDonutChart === 'function') {
        try { drawDonutChart(totalExpThisMonth, Math.max(0, freeCashFlow)); } catch (e) { console.error(e); }
    }
}

function renderBudgetCategoryRows(results) {
    const container = document.getElementById('budgetCategoryRows');
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; padding: 20px 0; text-align:center;">Add transactions to see your spending breakdown.</div>';
        return;
    }

    const fmt2 = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v || 0);

    container.innerHTML = results.map(r => {
        const barColor = r.isOverBudget ? '#fb7185' : r.isNearBudget ? '#f59e0b' : '#34d399';
        const barWidth = r.limit > 0 ? Math.min(100, r.percentUsed) : 0;
        const alertIcon = r.isOverBudget ? '🔴' : r.isNearBudget ? '🟡' : '';

        return `<div class="budget-cat-row" data-cat="${r.cat}">
            <div class="budget-cat-header">
                <span class="budget-cat-name">${alertIcon} ${r.cat}</span>
                <div class="budget-cat-amounts">
                    <span class="budget-cat-actual" style="color:${barColor};">${fmt2(r.actual)}</span>
                    <span class="budget-cat-sep"> / </span>
                    <span class="budget-cat-limit-display" title="Click to set a budget limit" style="cursor:pointer; color:var(--text-muted);">${r.limit > 0 ? fmt2(r.limit) : 'No limit set'}</span>
                    <input type="number" class="budget-limit-input glass-input btn-small hidden-element" data-cat="${r.cat}" value="${r.limit || ''}" placeholder="Set limit" style="width:90px; padding:4px 8px;">
                </div>
            </div>
            <div class="budget-bar-track">
                <div class="budget-bar-fill" style="width: ${barWidth}%; background: ${barColor};"></div>
            </div>
            ${r.limit > 0 ? `<div class="budget-cat-footer">
                <span style="color:var(--text-muted); font-size:0.8rem;">${r.isOverBudget ? `Over by ${fmt2(r.actual - r.limit)}` : `${fmt2(r.remaining)} remaining`}</span>
            </div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.budget-cat-limit-display').forEach(el => {
        el.addEventListener('click', () => {
            const row = el.closest('.budget-cat-row');
            el.classList.add('hidden-element');
            const input = row.querySelector('.budget-limit-input');
            input.classList.remove('hidden-element');
            input.focus();
        });
    });

    container.querySelectorAll('.budget-limit-input').forEach(input => {
        const saveLimit = async () => {
            const cat = input.getAttribute('data-cat');
            const val = parseFloat(input.value) || 0;
            state.budgetLimits[cat] = val;
            input.classList.add('hidden-element');
            const row = input.closest('.budget-cat-row');
            row.querySelector('.budget-cat-limit-display').classList.remove('hidden-element');
            updateBudget();
            if (state.user) {
                await saveBudgetLimit(state.user.id, cat, val);
            }
        };
        input.addEventListener('blur', saveLimit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') saveLimit(); });
    });
}

function updatePurchases() {
    const hPrice = parseFloat(document.getElementById('targetHomePrice')?.value) || 0;
    const hDown = parseFloat(document.getElementById('downPayment')?.value) || 0;
    const hRate = state.marketRates.mortgage_30yr || 0;
    const lType = document.getElementById('loanType')?.value || 'conv';
    const isVaTaxExempt = document.getElementById('vaTaxExempt')?.checked || false;

    if (document.getElementById('targetHomePriceDisplay')) document.getElementById('targetHomePriceDisplay').textContent = fmt(hPrice);
    if (document.getElementById('liveMortgageRate')) document.getElementById('liveMortgageRate').textContent = `${hRate.toFixed(2)}%`;
    if (document.getElementById('downLabel')) document.getElementById('downLabel').textContent = `${hDown.toFixed(1)}%`;

    const hm = calculateHousingMatrix(hPrice, hDown, hRate, lType, isVaTaxExempt);
    if (document.getElementById('actualHousingPayment')) document.getElementById('actualHousingPayment').textContent = fmt(hm.actualPayment) + '/mo';
    if (document.getElementById('maxHomePriceValue')) document.getElementById('maxHomePriceValue').textContent = fmt(hm.maxPurchase);
    if (document.getElementById('maxHousing')) document.getElementById('maxHousing').textContent = fmt(hm.personalMax);

    const aPrice = parseFloat(document.getElementById('targetCarPrice')?.value) || 0;
    const aTerm = parseInt(document.getElementById('autoTerm')?.value, 10) || 48;
    const aRate = state.marketRates.auto_new || 0;

    if (document.getElementById('targetCarPriceDisplay')) document.getElementById('targetCarPriceDisplay').textContent = fmt(aPrice);
    if (document.getElementById('liveAutoRate')) document.getElementById('liveAutoRate').textContent = `${aRate.toFixed(2)}%`;

    const am = calculateAutoMatrix(aPrice, aTerm, aRate);
    if (document.getElementById('actualAutoPayment')) document.getElementById('actualAutoPayment').textContent = fmt(am.actualPayment) + '/mo';
    if (document.getElementById('maxCarPrice')) document.getElementById('maxCarPrice').textContent = fmt(am.maxPurchase);
    if (document.getElementById('maxTransport')) document.getElementById('maxTransport').textContent = fmt(am.personalMax);
}

function updateFIRE() {
    const c = parseFloat(document.getElementById('fireContribution')?.value) || 0;
    const r = parseFloat(document.getElementById('marketReturn')?.value) || 7;
    const inf = Number.isFinite(state.marketRates.inflation_cpi) && state.marketRates.inflation_cpi < 25
        ? state.marketRates.inflation_cpi
        : 3.1;
    const f = calculateFIRE(c, r, inf);

    if (document.getElementById('fiNumberValue')) document.getElementById('fiNumberValue').textContent = fmt(f.fiNumber);
    if (document.getElementById('fiAgeValue')) document.getElementById('fiAgeValue').textContent = f.finalAge;

    if (typeof drawFireChart === 'function') {
        try { drawFireChart(f.ages, f.balances, f.fiNumber); } catch (e) { console.error(e); }
    }
}

function updateBenchmarking() {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const grossedUpTaxFree = (state.taxFreeIncome * 12) / (1 - taxRate);
    const equiv = state.income + grossedUpTaxFree;

    let p = 50;
    if (state.locationData && equiv > 0) {
        const microP = getPercentile(state.locationData, state.householdType, state.sex, state.education, state.race, equiv);
        p = microP ?? Math.max(1, 100 - Math.floor(equiv / 2000));
    }

    if (document.getElementById('percentileValue')) document.getElementById('percentileValue').textContent = `Top ${p}%`;
    if (document.getElementById('detailedPercentiles')) document.getElementById('detailedPercentiles').textContent = `Based on your income vs. your local area`;

    if (typeof drawBellCurve === 'function') {
        try { drawBellCurve(p); } catch (e) { console.error(e); }
    }

    const compareData = state.compareLocationData;
    const compareTaxRate = compareData?.tax_rate ?? taxRate;
    const colDelta = (compareData?.col_multiplier ?? 1) / (state.locationData?.col_multiplier ?? 1);
    const nominalMonthly = (state.income / 12) * (1 - compareTaxRate) + state.taxFreeIncome;
    const altNet = nominalMonthly / colDelta;

    if (document.getElementById('altNetIncome')) document.getElementById('altNetIncome').textContent = fmt(altNet);
}

export async function renderStatementList() {
    if (!state.user) return;
    const listEl = document.getElementById('historicalStatementsList');
    if (!listEl) return;

    const files = await listStatements(state.user.id);
    listEl.innerHTML = '';

    if (files.length === 0) {
        listEl.innerHTML = '<div class="item-row no-border-bottom"><span style="color:var(--text-muted)">No uploads yet.</span></div>';
        return;
    }

    files.forEach(f => {
        if (f.name === '.emptyFolderPlaceholder') return;
        const div = document.createElement('div');
        div.className = 'item-row';
        const created = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
        div.innerHTML = `<span>${f.name}</span><span style="color:var(--text-muted); font-size:0.85rem;">${created}</span>`;
        listEl.appendChild(div);
    });
}