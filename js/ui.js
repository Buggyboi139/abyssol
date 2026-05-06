import { state } from './state.js';
import { fetchLocationData, saveUserProfile, listStatements } from './api.js';
import { calculateCashFlow, calculateHousingMatrix, calculateAutoMatrix, calculateFIRE, groupTransactionsByMonth, getPercentile } from './calculators.js';
import { drawHistoryChart, drawDonutChart, drawFireChart, drawBellCurve } from './charts.js';

function fmt(amt) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amt || 0); }

export function hydrateUI(profile) {
    document.getElementById('baseIncome').value = profile.income || '';
    document.getElementById('taxFreeIncome').value = profile.tax_free_income || '';
    document.getElementById('sharedContribution').value = profile.shared_contribution || '';
    document.getElementById('currentPortfolio').value = profile.portfolio || '';
    document.getElementById('creditScore').value = profile.credit_score || 720;
    document.getElementById('age').value = profile.age || 25;
    document.getElementById('location').value = profile.location || 'national';
    document.getElementById('householdType').value = profile.household_type || 'all';
    document.getElementById('sex').value = profile.sex || 'all';
    document.getElementById('education').value = profile.education || 'all';
    document.getElementById('race').value = profile.race || 'all';
}

export async function triggerCalculations() {
    state.income = parseFloat(document.getElementById('baseIncome').value) || 0;
    state.taxFreeIncome = parseFloat(document.getElementById('taxFreeIncome').value) || 0;
    state.sharedContribution = parseFloat(document.getElementById('sharedContribution').value) || 0;
    state.portfolio = parseFloat(document.getElementById('currentPortfolio').value) || 0;
    state.creditScore = parseFloat(document.getElementById('creditScore').value) || 720;
    state.age = parseInt(document.getElementById('age').value) || 25;
    state.location = document.getElementById('location').value;
    state.householdType = document.getElementById('householdType').value;
    state.sex = document.getElementById('sex').value;
    state.education = document.getElementById('education').value;
    state.race = document.getElementById('race').value;
    
    state.locationData = await fetchLocationData(state.location);

    if (state.user) {
        saveUserProfile(state.user.id, {
            income: state.income, 
            tax_free_income: state.taxFreeIncome,
            shared_contribution: state.sharedContribution,
            portfolio: state.portfolio, 
            credit_score: state.creditScore,
            age: state.age, 
            location: state.location,
            household_type: state.householdType,
            sex: state.sex,
            education: state.education,
            race: state.race
        });
    }

    updateOverview();
    updateBudget();
    updatePurchases();
    updateFIRE();
    updateBenchmarking();
}

function updateOverview() {
    document.getElementById('overviewLiquidity').textContent = fmt(state.portfolio);
    const grouped = groupTransactionsByMonth(state.transactions);
    const labels = Object.keys(grouped).sort();
    const inflows = labels.map(l => grouped[l].inflow);
    const outflows = labels.map(l => grouped[l].outflow);
    drawHistoryChart(labels, inflows, outflows);

    const ledger = document.getElementById('historicalLedger');
    ledger.innerHTML = '';
    labels.reverse().forEach(month => {
        const details = document.createElement('details');
        details.className = 'expense-category';
        details.innerHTML = `<summary class="category-header">${month} <span class="category-total">${fmt(grouped[month].outflow)}</span></summary><div class="category-body"></div>`;
        ledger.appendChild(details);
    });

    const net = ((state.income / 12) * (1 - (state.locationData?.tax_rate ?? 0.22))) + state.taxFreeIncome;
    let personalExp = 0;
    document.querySelectorAll('.expense-input').forEach(i => personalExp += (parseFloat(i.value) || 0));
    const cashFlow = net - personalExp - state.sharedContribution;
    const cfEl = document.getElementById('overviewCashFlow');
    cfEl.textContent = fmt(cashFlow);
    cfEl.style.color = cashFlow < 0 ? '#fb7185' : '#34d399';
    
    let avgSvRate = net > 0 ? (cashFlow / net) * 100 : 0;
    document.getElementById('overviewSavingsRate').textContent = `${avgSvRate.toFixed(1)}%`;
}

function updateBudget() {
    let personalExp = 0;
    document.querySelectorAll('.expense-input').forEach(i => personalExp += (parseFloat(i.value) || 0));
    const { personalDiscretionary, sharedObligation, freeCashFlow } = calculateCashFlow(personalExp);
    
    document.getElementById('budgetPersonal').textContent = fmt(personalDiscretionary);
    document.getElementById('budgetShared').textContent = fmt(sharedObligation);
    document.getElementById('budgetSavings').textContent = fmt(freeCashFlow);
    
    drawDonutChart(personalDiscretionary, sharedObligation, Math.max(0, freeCashFlow));
}

function updatePurchases() {
    const sH = parseFloat(document.getElementById('spouseHousingContribution').value) || 0;
    const hPrice = parseFloat(document.getElementById('targetHomePrice').value) || 0;
    const hDown = parseFloat(document.getElementById('downPayment').value) || 0;
    const hRate = state.marketRates.mortgage_30yr;
    const lType = document.getElementById('loanType').value;
    document.getElementById('targetHomePriceDisplay').textContent = fmt(hPrice);
    document.getElementById('liveMortgageRate').textContent = `${hRate.toFixed(2)}%`;
    
    const hm = calculateHousingMatrix(sH, hPrice, hDown, hRate, lType);
    document.getElementById('actualHousingPayment').textContent = fmt(hm.actualPayment) + '/mo';
    document.getElementById('maxHomePriceValue').textContent = fmt(hm.maxPurchase);
    document.getElementById('maxHousing').textContent = fmt(hm.combinedMax);

    const sA = parseFloat(document.getElementById('spouseAutoContribution').value) || 0;
    const aPrice = parseFloat(document.getElementById('targetCarPrice').value) || 0;
    const aTerm = parseInt(document.getElementById('autoTerm').value) || 48;
    const aRate = state.marketRates.auto_new;
    document.getElementById('targetCarPriceDisplay').textContent = fmt(aPrice);
    document.getElementById('liveAutoRate').textContent = `${aRate.toFixed(2)}%`;

    const am = calculateAutoMatrix(sA, aPrice, aTerm, aRate);
    document.getElementById('actualAutoPayment').textContent = fmt(am.actualPayment) + '/mo';
    document.getElementById('maxCarPrice').textContent = fmt(am.maxPurchase);
    document.getElementById('maxTransport').textContent = fmt(am.combinedMax);
}

function updateFIRE() {
    const c = parseFloat(document.getElementById('fireContribution').value) || 0;
    const r = parseFloat(document.getElementById('marketReturn').value) || 7;
    const inf = 3.1;
    const f = calculateFIRE(c, r, inf);
    document.getElementById('fiNumberValue').textContent = fmt(f.fiNumber);
    document.getElementById('fiAgeValue').textContent = f.finalAge;
    drawFireChart(f.ages, f.balances, f.fiNumber);
}

function updateBenchmarking() {
    const taxRate = state.locationData?.tax_rate ?? 0.22;
    const grossedUpTaxFree = (state.taxFreeIncome * 12) / (1 - taxRate);
    const equiv = state.income + grossedUpTaxFree + (state.sharedContribution * 12);
    
    let p = 50;
    if (state.locationData && equiv > 0) {
        const microP = getPercentile(state.locationData, state.householdType, state.sex, state.education, state.race, equiv);
        p = microP ?? Math.max(1, 100 - Math.floor(equiv/2000));
    }
    document.getElementById('percentileValue').textContent = `Top ${p}%`;
    document.getElementById('detailedPercentiles').textContent = `Based on personal income vs localized deep demographics`;
    drawBellCurve(p);
    
    const compareLoc = document.getElementById('geoCompare').value;
    const compareTaxRate = 0.22; 
    const altNet = ((state.income / 12) * (1 - compareTaxRate)) + state.taxFreeIncome;
    document.getElementById('altNetIncome').textContent = fmt(altNet);
}

export async function renderStatementList() {
    if (!state.user) return;
    const listEl = document.getElementById('historicalStatementsList');
    if (!listEl) return;
    
    const files = await listStatements(state.user.id);
    listEl.innerHTML = '';
    
    if (files.length === 0) {
        listEl.innerHTML = '<div class="item-row no-border-bottom"><span style="color:var(--text-muted)">No historical uploads found.</span></div>';
        return;
    }
    
    files.forEach(f => {
        if (f.name === '.emptyFolderPlaceholder') return;
        const div = document.createElement('div');
        div.className = 'item-row';
        div.innerHTML = `<span>${f.name}</span><span style="color:var(--text-muted); font-size:0.85rem;">${new Date(f.created_at).toLocaleDateString()}</span>`;
        listEl.appendChild(div);
    });
}