document.addEventListener("DOMContentLoaded", function() {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

    const charts = {
        bell: null,
        donut: null,
        fire: null
    };

    let abortController = null;
    let userEditedDownPayment = false;
    let userEditedFIRE = false;

    const state = {
        incomeType: 'annual',
        taxableMonthlyGross: 0,
        totalGross: 0,
        annualGross: 0,
        taxExempt: 0,
        taxRate: 0.22,
        needs: 0,
        wants: 0,
        savings: 0,
        housingMax: 0,
        locationData: null,
        location: 'national'
    };

    const els = {};

    function cacheElements() {
        const ids =[
            'calculateBtn','backBtn','setupForm','setup-view','results-view','errorBanner',
            'baseIncome','baseIncomeLabel','hoursWrapper','hoursPerWeek','taxExemptIncome',
            'monthlyDebt','location','age','householdType','sex','education','race',
            'percentileValue','detailedPercentiles','netIncomeValue',
            'grossMonthlyValue','netMonthlyValue','totalAnnualValue',
            'budgetTitle','labelNeeds','labelWants','labelSavings',
            'budgetNeeds','budgetWants','budgetSavings',
            'remainingWantsValue','maxHousing','maxTotalDebt','availableDebtCapacity',
            'maxTransport','maxCarPrice','loanType','loanTerm','interestRate','downPayment',
            'rateLabel','downLabel','propertyTax','propTaxLabel','homeInsurance','homeInsLabel',
            'vetExempt','maxHomePriceValue','autoType','autoTerm','autoRate','autoRateLabel',
            'autoCount','geoCompare','altNetIncome','altMaxHousing','fiNumberValue','fiAgeValue',
            'fireContribution','currentPortfolio','marketReturn','inflationRate',
            'targetHomePrice','targetHomePriceDisplay','actualHousingPayment',
            'targetCarPrice','targetCarPriceDisplay','actualAutoPayment',
            'benchMedian','benchTop25','benchTop10','benchTop1',
            'geoNetLabel','geoHousingLabel','geoDiffText'
        ];
        ids.forEach(id => els[id] = document.getElementById(id));
        els.incomeTypeTabs = document.querySelectorAll('.menu-tab-btn');
        els.lifestyleInputs = document.querySelectorAll('.lifestyle-input');
    }

    function formatCurrency(amount) {
        if (!isFinite(amount)) return '$—';
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0
        }).format(amount);
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.classList.add('visible');
    }

    function clearError() {
        els.errorBanner.textContent = '';
        els.errorBanner.classList.remove('visible');
    }

    function validateNumericInput(el, minVal = 0, maxVal = Infinity) {
        const val = parseFloat(el.value);
        if (el.value === '' || isNaN(val)) {
            if (el.hasAttribute('required')) {
                el.classList.add('invalid');
                return false;
            }
            el.classList.remove('invalid');
            return true;
        }
        if (val < minVal || val > maxVal || !isFinite(val)) {
            el.classList.add('invalid');
            return false;
        }
        el.classList.remove('invalid');
        return true;
    }

    function validateAll() {
        let ok = true;
        ok = validateNumericInput(els.baseIncome, 0, 1e12) && ok;
        ok = validateNumericInput(els.hoursPerWeek, 1, 168) && ok;
        ok = validateNumericInput(els.taxExemptIncome, 0, 1e12) && ok;
        ok = validateNumericInput(els.monthlyDebt, 0, 1e12) && ok;
        ok = validateNumericInput(els.age, 18, 100) && ok;
        ok = validateNumericInput(els.marketReturn, 0, 100) && ok;
        ok = validateNumericInput(els.inflationRate, 0, 100) && ok;
        return ok;
    }

    async function fetchLocationData(loc) {
        if (abortController) abortController.abort();
        abortController = new AbortController();
        try {
            const res = await fetch(`data/${loc}.json`, { signal: abortController.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (err.name !== 'AbortError') {
                showError(`Unable to load data for ${loc.toUpperCase()}. Using national defaults.`);
            }
            return null;
        }
    }

    function getPercentile(data, ht, sx, ed, rc, income) {
        const brackets = data?.demographics?.[ht]?.[sx]?.[ed]?.[rc];
        if (!Array.isArray(brackets) || brackets.length === 0) return null;
        const idx = brackets.findIndex(b => b.income >= income);
        if (idx === -1) return 1;
        if (idx === 0 && income < brackets[0].income) return 99;
        return Math.max(1, 100 - brackets[idx].percentile);
    }

    function getBenchmarkIncome(data, ht, sx, ed, rc, targetPercentile) {
        const brackets = data?.demographics?.[ht]?.[sx]?.[ed]?.[rc];
        if (!Array.isArray(brackets)) return 0;
        const match = brackets.find(b => b.percentile >= targetPercentile);
        return match ? match.income : (brackets[brackets.length - 1]?.income || 0);
    }

    function updateIncomeTabs() {
        els.incomeTypeTabs.forEach(t => t.classList.remove('active'));
        const active = document.querySelector(`.menu-tab-btn[data-type="${state.incomeType}"]`);
        if (active) active.classList.add('active');

        if (state.incomeType === 'annual') {
            els.baseIncomeLabel.textContent = 'Annual Base Salary';
            els.hoursWrapper.classList.add('hidden-element');
        } else if (state.incomeType === 'monthly') {
            els.baseIncomeLabel.textContent = 'Monthly Gross Salary';
            els.hoursWrapper.classList.add('hidden-element');
        } else if (state.incomeType === 'hourly') {
            els.baseIncomeLabel.textContent = 'Hourly Wage';
            els.hoursWrapper.classList.remove('hidden-element');
        }
        els.baseIncome.value = '';
    }

    function calculateHousingMatrix() {
        if (state.housingMax <= 0) {
            els.maxHomePriceValue.textContent = '$0';
            return;
        }
        const maxMonthlyPayment = state.housingMax;
        const annualRate = parseFloat(els.interestRate.value) || 0;
        const termYears = parseInt(els.loanTerm.value) || 30;
        const downPct = (parseFloat(els.downPayment.value) || 0) / 100;
        const loanType = els.loanType.value;

        const r = annualRate / 100 / 12;
        const n = termYears * 12;

        let amortizationFactor = 0;
        if (r === 0) {
            amortizationFactor = 1 / n;
        } else {
            amortizationFactor = (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
        }

        let monthlyPropTaxRate = (parseFloat(els.propertyTax.value) || 0) / 100 / 12;
        if (els.vetExempt.checked) {
            monthlyPropTaxRate = 0;
            els.propertyTax.disabled = true;
            els.propTaxLabel.textContent = '0% (Exempt)';
        } else {
            els.propertyTax.disabled = false;
            els.propTaxLabel.textContent = `${parseFloat(els.propertyTax.value).toFixed(1)}%`;
        }

        const monthlyInsRate = (parseFloat(els.homeInsurance.value) || 0) / 100 / 12;

        let monthlyPMI = 0;
        if (loanType === 'fha' && downPct < 0.20) {
            monthlyPMI = 0.0085 / 12;
        } else if (loanType === 'conv' && downPct < 0.20) {
            monthlyPMI = 0.005 / 12;
        } else if (loanType === 'va') {
            monthlyPMI = 0;
        }

        const combinedFactor = ((1 - downPct) * amortizationFactor) +
                               monthlyPropTaxRate +
                               monthlyInsRate +
                               ((1 - downPct) * monthlyPMI);

        let maxHomePrice = 0;
        if (combinedFactor > 0) {
            maxHomePrice = maxMonthlyPayment / combinedFactor;
        }
        els.maxHomePriceValue.textContent = formatCurrency(maxHomePrice);
        calculateTargetHomePayment();
    }

    function calculateTargetHomePayment() {
        const price = parseFloat(els.targetHomePrice.value) || 0;
        els.targetHomePriceDisplay.textContent = formatCurrency(price);

        const annualRate = parseFloat(els.interestRate.value) || 0;
        const termYears = parseInt(els.loanTerm.value) || 30;
        const downPct = (parseFloat(els.downPayment.value) || 0) / 100;
        const loanType = els.loanType.value;
        const loanAmount = price * (1 - downPct);

        const r = annualRate / 100 / 12;
        const n = termYears * 12;

        let pmt = 0;
        if (loanAmount > 0) {
            if (r === 0) {
                pmt = loanAmount / n;
            } else {
                pmt = loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
            }
        }

        let monthlyPropTax = 0;
        if (!els.vetExempt.checked) {
            monthlyPropTax = price * ((parseFloat(els.propertyTax.value) || 0) / 100) / 12;
        }
        const monthlyIns = price * ((parseFloat(els.homeInsurance.value) || 0) / 100) / 12;

        let monthlyPMI = 0;
        if (loanType === 'fha' && downPct < 0.20) {
            monthlyPMI = loanAmount * 0.0085 / 12;
        } else if (loanType === 'conv' && downPct < 0.20) {
            monthlyPMI = loanAmount * 0.005 / 12;
        }

        const totalMonthly = pmt + monthlyPropTax + monthlyIns + monthlyPMI;
        els.actualHousingPayment.textContent = formatCurrency(totalMonthly) + '/mo';

        if (totalMonthly > state.housingMax + 0.01) {
            els.actualHousingPayment.style.color = '#fb7185';
        } else {
            els.actualHousingPayment.style.color = '';
        }
    }

    function calculateAuto() {
        const transportMax = state.totalGross * 0.10;
        els.maxTransport.textContent = formatCurrency(transportMax);

        const autoType = els.autoType.value;
        const term = parseInt(els.autoTerm.value) || 48;
        const rate = (parseFloat(els.autoRate.value) || 0) / 100 / 12;
        const count = parseInt(els.autoCount.value) || 1;

        if (count <= 0) {
            els.maxCarPrice.textContent = '$0';
            calculateTargetAutoPayment();
            return;
        }

        const budgetPerCar = transportMax / count;
        let maxPrice = 0;
        if (rate === 0) {
            if (autoType === 'buy') {
                maxPrice = (budgetPerCar * term) / 0.8;
            } else {
                maxPrice = (budgetPerCar * term) / 0.45;
            }
        } else {
            const pv = budgetPerCar * ((1 - Math.pow(1 + rate, -term)) / rate);
            if (autoType === 'buy') {
                maxPrice = pv / 0.8;
            } else {
                maxPrice = pv / 0.45;
            }
        }
        els.maxCarPrice.textContent = formatCurrency(maxPrice);
        calculateTargetAutoPayment();
    }

    function calculateTargetAutoPayment() {
        const price = parseFloat(els.targetCarPrice.value) || 0;
        els.targetCarPriceDisplay.textContent = formatCurrency(price);

        const autoType = els.autoType.value;
        const term = parseInt(els.autoTerm.value) || 48;
        const rate = (parseFloat(els.autoRate.value) || 0) / 100 / 12;
        const count = parseInt(els.autoCount.value) || 1;
        const transportMax = state.totalGross * 0.10;
        const budgetPerCar = transportMax / count;

        let pmt = 0;
        if (rate === 0) {
            pmt = price / term;
        } else {
            pmt = price * (rate * Math.pow(1 + rate, term)) / (Math.pow(1 + rate, term) - 1);
        }

        if (autoType === 'lease') {
            pmt = price * 0.45 / term;
            if (rate !== 0) {
                pmt = (price * 0.45) * (rate * Math.pow(1 + rate, term)) / (Math.pow(1 + rate, term) - 1);
            }
        }

        els.actualAutoPayment.textContent = formatCurrency(pmt) + '/mo';
        if (pmt > budgetPerCar + 0.01) {
            els.actualAutoPayment.style.color = '#fb7185';
        } else {
            els.actualAutoPayment.style.color = '';
        }
    }

    function updateLifestyleTracker() {
        let spent = 0;
        els.lifestyleInputs.forEach(input => {
            const v = parseFloat(input.value);
            if (!isNaN(v) && v > 0) spent += v;
        });
        const remaining = state.wants - spent;
        els.remainingWantsValue.textContent = formatCurrency(remaining);
        els.remainingWantsValue.style.color = remaining < 0 ? '#fb7185' : '';
    }

    async function calculateGeoArbitrage() {
        const compareLoc = els.geoCompare.value;
        let compareData = null;
        try {
            const res = await fetch(`data/${compareLoc}.json`);
            if (res.ok) compareData = await res.json();
        } catch (e) {
            
        }

        const compareTaxRate = compareData?.tax_rate ?? 0.22;
        const compareHousingMult = compareData?.housing_multiplier ?? 1.0;
        const currentHousingMult = state.locationData?.housing_multiplier ?? 1.0;

        const taxableMonthlyGross = state.taxableMonthlyGross;
        const altNet = (taxableMonthlyGross * (1 - compareTaxRate)) + state.taxExempt;
        els.altNetIncome.textContent = formatCurrency(altNet);

        const equivalentHousing = state.housingMax * (compareHousingMult / currentHousingMult);
        els.altMaxHousing.textContent = formatCurrency(equivalentHousing);

        const locNames = {
            national: 'National Average',
            ny: 'New York, NY',
            ca: 'San Francisco, CA',
            tx: 'Austin, TX',
            il: 'Chicago, IL',
            fl: 'Miami, FL'
        };
        const name = locNames[compareLoc] || compareLoc;
        els.geoNetLabel.textContent = `Take-Home in ${name}`;
        els.geoHousingLabel.textContent = `Equiv. Housing in ${name}`;

        const netDiff = altNet - ((taxableMonthlyGross * (1 - state.taxRate)) + state.taxExempt);
        const housingDiff = equivalentHousing - state.housingMax;
        const diffText =[];
        if (netDiff > 0) diffText.push(`+${formatCurrency(netDiff)} take-home`);
        else if (netDiff < 0) diffText.push(`${formatCurrency(netDiff)} take-home`);
        if (housingDiff > 0) diffText.push(`+${formatCurrency(housingDiff)} housing budget`);
        else if (housingDiff < 0) diffText.push(`${formatCurrency(housingDiff)} housing budget`);
        els.geoDiffText.textContent = diffText.length ? diffText.join(' • ') : 'No change in purchasing power.';
    }

    function drawCharts(percentile, needs, wants, savings) {
        if (charts.bell) charts.bell.destroy();
        if (charts.donut) charts.donut.destroy();

        const bellCtx = document.getElementById('bellCurveChart').getContext('2d');
        const xValues =[];
        const yValues =[];
        for (let i = 0; i <= 100; i += 2) {
            xValues.push(i);
            const y = Math.exp(-Math.pow(i - 50, 2) / (2 * Math.pow(15, 2)));
            yValues.push(y);
        }
        const pointIndex = xValues.findIndex(x => x >= (100 - percentile));

        charts.bell = new Chart(bellCtx, {
            type: 'line',
            data: {
                labels: xValues,
                datasets:[{
                    label: 'Population Distribution',
                    data: yValues,
                    borderColor: 'rgba(59, 130, 246, 0.5)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }, {
                    label: 'You',
                    data: xValues.map((x, i) => i === pointIndex ? yValues[i] : null),
                    borderColor: '#38bdf8',
                    backgroundColor: '#38bdf8',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { display: false },
                    y: { display: false }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                if (context.datasetIndex === 1 && context.raw !== null) {
                                    return `Your Position: Top ${percentile}%`;
                                }
                                return null;
                            }
                        }
                    }
                }
            }
        });

        const donutCtx = document.getElementById('budgetDonutChart').getContext('2d');
        charts.donut = new Chart(donutCtx, {
            type: 'doughnut',
            data: {
                labels:['Needs', 'Wants', 'Savings/Debt'],
                datasets:[{
                    data: [needs, wants, savings],
                    backgroundColor:['#3b82f6', '#0ea5e9', '#38bdf8'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#f8fafc' }
                    }
                }
            }
        });
    }

    function calculateFIRE() {
        const age = parseInt(els.age.value) || 25;
        let portfolio = parseFloat(els.currentPortfolio.value) || 0;
        const returnRate = parseFloat(els.marketReturn.value) || 7;
        const inflation = parseFloat(els.inflationRate.value) || 3;
        let contribution = parseFloat(els.fireContribution.value) || 0;

        const annualExpenses = (state.needs + state.wants) * 12;
        const fiNumber = annualExpenses * 25;
        const realReturn = (returnRate - inflation) / 100;

        els.fiNumberValue.textContent = formatCurrency(fiNumber);

        if (contribution <= 0 && portfolio < fiNumber && realReturn <= 0) {
            els.fiAgeValue.textContent = 'Never';
            if (charts.fire) {
                charts.fire.destroy();
                charts.fire = null;
            }
            return;
        }

        let currentAge = age;
        let ages = [currentAge];
        let balances = [portfolio];
        let annualSavings = contribution * 12;

        while (portfolio < fiNumber && currentAge < 100) {
            portfolio = portfolio * (1 + realReturn) + annualSavings;
            currentAge++;
            ages.push(currentAge);
            balances.push(portfolio);
            annualSavings = annualSavings * (1 + inflation / 100);
        }

        if (portfolio >= fiNumber) {
            els.fiAgeValue.textContent = currentAge;
        } else {
            els.fiAgeValue.textContent = '100+';
        }

        if (charts.fire) charts.fire.destroy();

        const fireCtx = document.getElementById('fireChart').getContext('2d');
        charts.fire = new Chart(fireCtx, {
            type: 'line',
            data: {
                labels: ages,
                datasets:[{
                    label: 'Portfolio Balance',
                    data: balances,
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52, 211, 153, 0.1)',
                    fill: true,
                    tension: 0.1,
                    pointRadius: 2
                }, {
                    label: 'FI Target',
                    data: Array(ages.length).fill(fiNumber),
                    borderColor: '#fb7185',
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        title: { display: true, text: 'Age', color: '#94a3b8' },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: {
                            callback: function(value) {
                                if (value >= 1000000) return '$' + (value / 1000000).toFixed(1) + 'M';
                                if (value >= 1000) return '$' + (value / 1000).toFixed(0) + 'k';
                                return '$' + value;
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: '#f8fafc' }
                    }
                }
            }
        });
    }

    async function handleCalculate(e) {
        if (e) e.preventDefault();
        clearError();

        if (!validateAll()) {
            showError('Please correct the highlighted fields.');
            return;
        }

        const baseIncomeRaw = parseFloat(els.baseIncome.value) || 0;
        const taxExemptMonthly = parseFloat(els.taxExemptIncome.value) || 0;
        const existingDebt = parseFloat(els.monthlyDebt.value) || 0;
        const hours = parseFloat(els.hoursPerWeek.value) || 40;

        const location = els.location.value;
        const ht = els.householdType.value;
        const sx = els.sex.value;
        const ed = els.education.value;
        const rc = els.race.value;

        let taxableMonthlyGross = 0;
        let annualGross = 0;

        if (state.incomeType === 'annual') {
            taxableMonthlyGross = baseIncomeRaw / 12;
            annualGross = baseIncomeRaw;
        } else if (state.incomeType === 'monthly') {
            taxableMonthlyGross = baseIncomeRaw;
            annualGross = baseIncomeRaw * 12;
        } else if (state.incomeType === 'hourly') {
            taxableMonthlyGross = (baseIncomeRaw * hours * 52) / 12;
            annualGross = baseIncomeRaw * hours * 52;
        }

        state.taxableMonthlyGross = taxableMonthlyGross;
        state.taxExempt = taxExemptMonthly;
        state.totalGross = taxableMonthlyGross + taxExemptMonthly;
        state.annualGross = annualGross;
        state.location = location;

        const totalAnnualEquivalent = annualGross + (taxExemptMonthly * 12);

        const fetchedData = await fetchLocationData(location);
        state.locationData = fetchedData;
        state.taxRate = fetchedData ? fetchedData.tax_rate : 0.22;

        const netTaxableIncome = taxableMonthlyGross * (1 - state.taxRate);
        const totalNetMonthly = netTaxableIncome + taxExemptMonthly;

        let needsRatio = 0.50;
        let wantsRatio = 0.30;
        let savingsRatio = 0.20;

        if (location === 'ca' || location === 'ny') {
            needsRatio = 0.65;
            wantsRatio = 0.15;
            savingsRatio = 0.20;
            els.budgetTitle.textContent = '65/15/20 Budgeting Framework (HCOL Adjusted)';
            els.labelNeeds.textContent = 'Needs (65%)';
            els.labelWants.textContent = 'Wants (15%)';
            els.labelSavings.textContent = 'Savings & Debt (20%)';
        } else {
            els.budgetTitle.textContent = '50/30/20 Budgeting Framework';
            els.labelNeeds.textContent = 'Needs (50%)';
            els.labelWants.textContent = 'Wants (30%)';
            els.labelSavings.textContent = 'Savings & Debt (20%)';
        }

        state.needs = totalNetMonthly * needsRatio;
        state.wants = totalNetMonthly * wantsRatio;
        state.savings = totalNetMonthly * savingsRatio;

        state.housingMax = state.totalGross * 0.28;
        const totalDebtMax = state.totalGross * 0.36;
        const remainingDebtCapacity = Math.max(0, totalDebtMax - state.housingMax - existingDebt);

        const microP = getPercentile(fetchedData, ht, sx, ed, rc, totalAnnualEquivalent) ?? null;
        const macroP = getPercentile(fetchedData, 'all', 'all', 'all', 'all', totalAnnualEquivalent) ?? null;
        const sexP = getPercentile(fetchedData, 'all', sx, 'all', 'all', totalAnnualEquivalent) ?? null;
        const raceP = getPercentile(fetchedData, 'all', 'all', 'all', rc, totalAnnualEquivalent) ?? null;

        let fallbackP = null;
        if (microP === null) {
            fallbackP = Math.max(1, Math.min(99, 100 - Math.floor(totalAnnualEquivalent / 150)));
        }
        const finalMicro = microP ?? fallbackP ?? 50;
        const finalMacro = macroP ?? fallbackP ?? 50;
        const finalSex = sexP ?? fallbackP ?? 50;
        const finalRace = raceP ?? fallbackP ?? 50;

        els.percentileValue.textContent = `Top ${finalMicro}%`;

        let details = `Overall: Top ${finalMacro}% National`;
        if (sx !== 'all') {
            details += ` \u2022 Top ${finalSex}% of ${els.sex.options[els.sex.selectedIndex].text}`;
        }
        if (rc !== 'all') {
            details += ` \u2022 Top ${finalRace}% of ${els.race.options[els.race.selectedIndex].text}`;
        }
        els.detailedPercentiles.textContent = details;

        els.netIncomeValue.textContent = formatCurrency(totalNetMonthly);
        els.grossMonthlyValue.textContent = formatCurrency(state.totalGross);
        els.netMonthlyValue.textContent = formatCurrency(totalNetMonthly);
        els.totalAnnualValue.textContent = formatCurrency(totalAnnualEquivalent);

        els.budgetNeeds.textContent = formatCurrency(state.needs);
        els.budgetWants.textContent = formatCurrency(state.wants);
        els.budgetSavings.textContent = formatCurrency(state.savings);

        if (!userEditedFIRE) {
            els.fireContribution.value = Math.round(state.savings);
        }

        els.maxHousing.textContent = formatCurrency(state.housingMax);
        els.maxTotalDebt.textContent = formatCurrency(totalDebtMax);
        els.availableDebtCapacity.textContent = formatCurrency(remainingDebtCapacity);

        if (fetchedData) {
            els.benchMedian.textContent = formatCurrency(getBenchmarkIncome(fetchedData, ht, sx, ed, rc, 50));
            els.benchTop25.textContent = formatCurrency(getBenchmarkIncome(fetchedData, ht, sx, ed, rc, 75));
            els.benchTop10.textContent = formatCurrency(getBenchmarkIncome(fetchedData, ht, sx, ed, rc, 90));
            els.benchTop1.textContent = formatCurrency(getBenchmarkIncome(fetchedData, ht, sx, ed, rc, 99));
        } else {
            els.benchMedian.textContent = '$0';
            els.benchTop25.textContent = '$0';
            els.benchTop10.textContent = '$0';
            els.benchTop1.textContent = '$0';
        }

        calculateAuto();
        calculateHousingMatrix();
        updateLifestyleTracker();
        calculateGeoArbitrage();
        drawCharts(finalMicro, state.needs, state.wants, state.savings);
        calculateFIRE();

        els['setup-view'].classList.remove('active-view');
        els['setup-view'].classList.add('hidden-view');
        els['results-view'].classList.remove('hidden-view');
        els['results-view'].classList.add('active-view');
        window.scrollTo(0, 0);
    }

    function handleBack() {
        els['results-view'].classList.remove('active-view');
        els['results-view'].classList.add('hidden-view');
        els['setup-view'].classList.remove('hidden-view');
        els['setup-view'].classList.add('active-view');
        window.scrollTo(0, 0);
    }

    function bindEvents() {
        els.setupForm.addEventListener('submit', handleCalculate);
        els.backBtn.addEventListener('click', handleBack);

        els.incomeTypeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                state.incomeType = tab.getAttribute('data-type');
                updateIncomeTabs();
            });
        });

        els.loanType.addEventListener('change', function() {
            if (!userEditedDownPayment) {
                if (this.value === 'va') els.downPayment.value = 0;
                else if (this.value === 'fha') els.downPayment.value = 3.5;
                else if (this.value === 'conv') els.downPayment.value = 20;
                els.downLabel.textContent = `${parseFloat(els.downPayment.value).toFixed(1)}%`;
            }
            calculateHousingMatrix();
        });

        els.downPayment.addEventListener('input', function() {
            userEditedDownPayment = true;
            els.downLabel.textContent = `${parseFloat(this.value).toFixed(1)}%`;
            calculateHousingMatrix();
        });

        els.loanTerm.addEventListener('change', calculateHousingMatrix);
        els.interestRate.addEventListener('input', function() {
            els.rateLabel.textContent = `${parseFloat(this.value).toFixed(1)}%`;
            calculateHousingMatrix();
        });
        els.propertyTax.addEventListener('input', calculateHousingMatrix);
        els.homeInsurance.addEventListener('input', function() {
            els.homeInsLabel.textContent = `${parseFloat(this.value).toFixed(1)}%`;
            calculateHousingMatrix();
        });
        els.vetExempt.addEventListener('change', calculateHousingMatrix);

        els.targetHomePrice.addEventListener('input', calculateTargetHomePayment);

        els.autoType.addEventListener('change', calculateAuto);
        els.autoTerm.addEventListener('change', calculateAuto);
        els.autoCount.addEventListener('change', calculateAuto);
        els.autoRate.addEventListener('input', function() {
            els.autoRateLabel.textContent = `${parseFloat(this.value).toFixed(1)}%`;
            calculateAuto();
        });
        els.targetCarPrice.addEventListener('input', calculateTargetAutoPayment);

        els.lifestyleInputs.forEach(input => {
            input.addEventListener('input', updateLifestyleTracker);
        });

        els.geoCompare.addEventListener('change', calculateGeoArbitrage);

        els.fireContribution.addEventListener('input', function() {
            userEditedFIRE = true;
            calculateFIRE();
        });
        els.currentPortfolio.addEventListener('input', calculateFIRE);
        els.marketReturn.addEventListener('input', calculateFIRE);
        els.inflationRate.addEventListener('input', calculateFIRE);

        [els.baseIncome, els.hoursPerWeek, els.taxExemptIncome, els.monthlyDebt,
         els.age, els.marketReturn, els.inflationRate].forEach(el => {
            el.addEventListener('input', () => validateNumericInput(el));
        });
    }

    cacheElements();
    bindEvents();
    updateIncomeTabs();
});