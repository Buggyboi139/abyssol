import { state } from './state.js';
import { fetchLocationData, saveUserProfile, listStatements } from './api.js';
import { calculateCashFlow, calculateHousingMatrix, calculateAutoMatrix, calculateFIRE, groupTransactionsByMonth, getPercentile, groupTransactionsByCategory, filterTransactions, groupTransactionsByMerchant, calculateSpendingPace, normalizeCat } from './calculators.js';
import { drawHistoryChart, drawDonutChart, drawFireChart, drawBellCurve, drawCategoryDonutChart, drawMerchantChart } from './charts.js';
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
        race: state.race
    };
}

const locationCache = {};

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

    updateOverview();
    updateBudget();
    updatePurchases();
    updateFIRE();
    updateBenchmarking();
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
            <span style="color:${color}; font-weight:600; width:80px; text-align:right;">${prefix}${fmt(Math.abs(amt))}</span>
            <button class="delete-tx-btn" data-id="${t.id}" title="Delete">🗑️</button>
        </div>`;
    }).join('');
}

function updateOverview() {
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

    const pace = calculateSpendingPace(state.transactions);
    const paceEl = document.getElementById('kpiSpendingPace');
    if (paceEl) {
        paceEl.textContent = fmt(pace.projectedTotal);
        const taxRate = state.locationData?.tax_rate ?? 0.22;
        const monthlyIncome = ((state.income / 12) * (1 - taxRate)) + state.taxFreeIncome;
        paceEl.style.color = pace.projectedTotal > monthlyIncome ? '#fb7185' : '#34d399';
    }

    renderFlatLedger(filtered);

    if (state.activeView === 'timeline') {
        const grouped = groupTransactionsByMonth(filtered);
        const labels = Object.keys(grouped).sort();
        const inflows = labels.map(l => grouped[l].inflow);
        const outflows = labels.map(l => grouped[l].outflow);
        if (typeof drawHistoryChart === 'function') drawHistoryChart(labels, inflows, outflows);
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
    const filtered = filterTransactions(state.transactions, state.filters);
    let totalExp = 0;
    filtered.forEach(t => {
        if (t.type === 'expense' || Number(t.amount) < 0) {
            totalExp += Math.abs(Number(t.amount) || 0);
        }
    });

    const { netPersonalMonthly, freeCashFlow } = calculateCashFlow(totalExp);

    if (document.getElementById('budgetTotalSpend')) document.getElementById('budgetTotalSpend').textContent = fmt(totalExp);
    if (document.getElementById('budgetMonthlyIncome')) document.getElementById('budgetMonthlyIncome').textContent = fmt(netPersonalMonthly);
    if (document.getElementById('budgetLeftOver')) document.getElementById('budgetLeftOver').textContent = fmt(Math.max(0, freeCashFlow));

    if (typeof drawDonutChart === 'function') {
        try {
            drawDonutChart(totalExp, Math.max(0, freeCashFlow));
        } catch (e) {
            console.error(e);
        }
    }
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
