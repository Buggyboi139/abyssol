document.addEventListener("DOMContentLoaded", function() {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

    let bellChartInst = null;
    let donutChartInst = null;
    let fireChartInst = null;

    const calculateBtn = document.getElementById("calculateBtn");
    const backBtn = document.getElementById("backBtn");
    const setupView = document.getElementById("setup-view");
    const resultsView = document.getElementById("results-view");
    
    const incomeTypeTabs = document.querySelectorAll(".menu-tab-btn");
    let currentIncomeType = "annual";
    
    const baseIncomeInput = document.getElementById("baseIncome");
    const baseIncomeLabel = document.getElementById("baseIncomeLabel");
    const hoursWrapper = document.getElementById("hoursWrapper");
    const hoursPerWeekInput = document.getElementById("hoursPerWeek");
    const taxExemptIncomeInput = document.getElementById("taxExemptIncome");
    const monthlyDebtInput = document.getElementById("monthlyDebt");
    const locationSelect = document.getElementById("location");
    const ageInput = document.getElementById("age");
    const householdTypeSelect = document.getElementById("householdType");
    const sexSelect = document.getElementById("sex");
    const educationSelect = document.getElementById("education");
    const raceSelect = document.getElementById("race");
    
    const percentileValue = document.getElementById("percentileValue");
    const detailedPercentiles = document.getElementById("detailedPercentiles");
    const netIncomeValue = document.getElementById("netIncomeValue");
    
    const budgetTitle = document.getElementById("budgetTitle");
    const labelNeeds = document.getElementById("labelNeeds");
    const labelWants = document.getElementById("labelWants");
    const labelSavings = document.getElementById("labelSavings");
    const budgetNeeds = document.getElementById("budgetNeeds");
    const budgetWants = document.getElementById("budgetWants");
    const budgetSavings = document.getElementById("budgetSavings");
    
    const remainingWantsValue = document.getElementById("remainingWantsValue");
    const lifestyleInputs = document.querySelectorAll(".lifestyle-input");

    const maxHousing = document.getElementById("maxHousing");
    const maxTotalDebt = document.getElementById("maxTotalDebt");
    const availableDebtCapacity = document.getElementById("availableDebtCapacity");
    
    const maxTransport = document.getElementById("maxTransport");
    const maxCarPrice = document.getElementById("maxCarPrice");

    const loanTypeSelect = document.getElementById("loanType");
    const loanTermSelect = document.getElementById("loanTerm");
    const interestRateSlider = document.getElementById("interestRate");
    const downPaymentSlider = document.getElementById("downPayment");
    const rateLabel = document.getElementById("rateLabel");
    const downLabel = document.getElementById("downLabel");
    const propertyTaxSlider = document.getElementById("propertyTax");
    const propTaxLabel = document.getElementById("propTaxLabel");
    const homeInsuranceSlider = document.getElementById("homeInsurance");
    const homeInsLabel = document.getElementById("homeInsLabel");
    const vetExemptCheckbox = document.getElementById("vetExempt");
    const maxHomePriceValue = document.getElementById("maxHomePriceValue");

    const autoTypeSelect = document.getElementById("autoType");
    const autoTermSelect = document.getElementById("autoTerm");
    const autoRateSlider = document.getElementById("autoRate");
    const autoRateLabel = document.getElementById("autoRateLabel");
    const autoCountSelect = document.getElementById("autoCount");

    const geoCompareSelect = document.getElementById("geoCompare");
    const altNetIncome = document.getElementById("altNetIncome");
    const altMaxHousing = document.getElementById("altMaxHousing");

    const fireContributionInput = document.getElementById("fireContribution");
    const currentPortfolioInput = document.getElementById("currentPortfolio");
    const marketReturnInput = document.getElementById("marketReturn");
    const inflationRateInput = document.getElementById("inflationRate");
    const fiNumberValue = document.getElementById("fiNumberValue");
    const fiAgeValue = document.getElementById("fiAgeValue");

    let currentCalculatedTotalGross = 0;
    let currentCalculatedHousingMax = 0;
    let currentCalculatedWants = 0;
    let currentCalculatedSavings = 0;
    let currentCalculatedNeeds = 0;
    let currentTaxExempt = 0;
    let currentTaxRate = 0.22;
    let userEditedFIRE = false;

    function formatCurrency(amount) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0
        }).format(amount);
    }

    incomeTypeTabs.forEach(tab => {
        tab.addEventListener("click", function() {
            incomeTypeTabs.forEach(t => t.classList.remove("active"));
            this.classList.add("active");
            currentIncomeType = this.getAttribute("data-type");

            if (currentIncomeType === "annual") {
                baseIncomeLabel.innerText = "Annual Base Salary";
                hoursWrapper.classList.add("hidden-element");
            } else if (currentIncomeType === "monthly") {
                baseIncomeLabel.innerText = "Monthly Gross Salary";
                hoursWrapper.classList.add("hidden-element");
            } else if (currentIncomeType === "hourly") {
                baseIncomeLabel.innerText = "Hourly Wage";
                hoursWrapper.classList.remove("hidden-element");
            }
            baseIncomeInput.value = "";
        });
    });

    function calculateHousingMatrix() {
        if (currentCalculatedHousingMax <= 0) {
            maxHomePriceValue.innerText = "$0";
            return;
        }

        const maxMonthlyPayment = currentCalculatedHousingMax;
        const annualInterestRate = parseFloat(interestRateSlider.value);
        const loanTermYears = parseInt(loanTermSelect.value);
        const downPaymentPct = parseFloat(downPaymentSlider.value) / 100;
        const loanType = loanTypeSelect.value;

        const r = annualInterestRate / 100 / 12;
        const n = loanTermYears * 12;

        let amortizationFactor = 0;
        if (r === 0) {
            amortizationFactor = 1 / n;
        } else {
            amortizationFactor = (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
        }

        let monthlyPropertyTaxRate = (parseFloat(propertyTaxSlider.value) / 100) / 12;
        if (vetExemptCheckbox.checked) {
            monthlyPropertyTaxRate = 0;
            propertyTaxSlider.disabled = true;
            propTaxLabel.innerText = "0% (Exempt)";
        } else {
            propertyTaxSlider.disabled = false;
            propTaxLabel.innerText = `${parseFloat(propertyTaxSlider.value).toFixed(1)}%`;
        }

        const monthlyInsuranceRate = (parseFloat(homeInsuranceSlider.value) / 100) / 12;

        let monthlyPMIRate = 0;
        if (loanType === 'fha' && downPaymentPct < 0.20) {
            monthlyPMIRate = 0.0085 / 12;
        } else if (loanType === 'conv' && downPaymentPct < 0.20) {
            monthlyPMIRate = 0.005 / 12;
        } else if (loanType === 'va') {
            monthlyPMIRate = 0;
        }

        const combinedFactor = ((1 - downPaymentPct) * amortizationFactor) + 
                               monthlyPropertyTaxRate + 
                               monthlyInsuranceRate + 
                               ((1 - downPaymentPct) * monthlyPMIRate);

        let maxHomePrice = 0;
        if (combinedFactor > 0) {
            maxHomePrice = maxMonthlyPayment / combinedFactor;
        }

        maxHomePriceValue.innerText = formatCurrency(maxHomePrice);
    }

    loanTypeSelect.addEventListener("change", function() {
        if (this.value === 'va') {
            downPaymentSlider.value = 0;
        } else if (this.value === 'fha') {
            downPaymentSlider.value = 3.5;
        } else if (this.value === 'conv') {
            downPaymentSlider.value = 20;
        }
        downLabel.innerText = `${parseFloat(downPaymentSlider.value).toFixed(1)}%`;
        calculateHousingMatrix();
    });

    loanTermSelect.addEventListener("change", calculateHousingMatrix);
    interestRateSlider.addEventListener("input", function() {
        rateLabel.innerText = `${parseFloat(this.value).toFixed(1)}%`;
        calculateHousingMatrix();
    });
    downPaymentSlider.addEventListener("input", function() {
        downLabel.innerText = `${parseFloat(this.value).toFixed(1)}%`;
        calculateHousingMatrix();
    });
    propertyTaxSlider.addEventListener("input", calculateHousingMatrix);
    homeInsuranceSlider.addEventListener("input", function() {
        homeInsLabel.innerText = `${parseFloat(this.value).toFixed(1)}%`;
        calculateHousingMatrix();
    });
    vetExemptCheckbox.addEventListener("change", calculateHousingMatrix);

    function calculateAuto() {
        const transportMax = currentCalculatedTotalGross * 0.10;
        maxTransport.innerText = formatCurrency(transportMax);

        const autoType = autoTypeSelect.value;
        const term = parseInt(autoTermSelect.value);
        const rate = parseFloat(autoRateSlider.value) / 100 / 12;
        const count = parseInt(autoCountSelect.value);

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

        maxCarPrice.innerText = formatCurrency(maxPrice);
    }

    autoTypeSelect.addEventListener("change", calculateAuto);
    autoTermSelect.addEventListener("change", calculateAuto);
    autoCountSelect.addEventListener("change", calculateAuto);
    autoRateSlider.addEventListener("input", function() {
        autoRateLabel.innerText = `${parseFloat(this.value).toFixed(1)}%`;
        calculateAuto();
    });

    function updateLifestyleTracker() {
        let spent = 0;
        lifestyleInputs.forEach(input => {
            spent += parseFloat(input.value) || 0;
        });
        const remaining = currentCalculatedWants - spent;
        remainingWantsValue.innerText = formatCurrency(remaining);
        if (remaining < 0) {
            remainingWantsValue.style.color = "#fb7185";
        } else {
            remainingWantsValue.style.color = "";
        }
    }

    lifestyleInputs.forEach(input => {
        input.addEventListener("input", updateLifestyleTracker);
    });

    async function calculateGeoArbitrage() {
        const compareLoc = geoCompareSelect.value;
        let compareTaxRate = 0.22;
        
        try {
            const res = await fetch(`data/${compareLoc}.json`);
            const data = await res.json();
            compareTaxRate = data.tax_rate;
        } catch (e) {}
        
        const taxableMonthlyGross = currentCalculatedTotalGross - currentTaxExempt;
        const altNet = (taxableMonthlyGross * (1 - compareTaxRate)) + currentTaxExempt;
        
        altNetIncome.innerText = formatCurrency(altNet);
        altMaxHousing.innerText = formatCurrency(currentCalculatedTotalGross * 0.28);
    }

    geoCompareSelect.addEventListener("change", calculateGeoArbitrage);

    function drawCharts(percentile, needs, wants, savings) {
        if (bellChartInst) bellChartInst.destroy();
        if (donutChartInst) donutChartInst.destroy();

        const bellCtx = document.getElementById('bellCurveChart').getContext('2d');
        const xValues = [];
        const yValues =[];
        for (let i = 0; i <= 100; i += 2) {
            xValues.push(i);
            const y = Math.exp(-Math.pow(i - 50, 2) / (2 * Math.pow(15, 2)));
            yValues.push(y);
        }

        const pointIndex = xValues.findIndex(x => x >= (100 - percentile));

        bellChartInst = new Chart(bellCtx, {
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
        donutChartInst = new Chart(donutCtx, {
            type: 'doughnut',
            data: {
                labels: ['Needs', 'Wants', 'Savings/Debt'],
                datasets: [{
                    data:[needs, wants, savings],
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
        let age = parseInt(ageInput.value) || 25;
        let portfolio = parseFloat(currentPortfolioInput.value) || 0;
        let returnRate = parseFloat(marketReturnInput.value) || 7;
        let inflation = parseFloat(inflationRateInput.value) || 3;
        let contribution = parseFloat(fireContributionInput.value) || 0;
        
        const annualExpenses = (currentCalculatedNeeds + currentCalculatedWants) * 12;
        const fiNumber = annualExpenses * 25;
        const annualSavings = contribution * 12;

        fiNumberValue.innerText = formatCurrency(fiNumber);

        const r = (returnRate - inflation) / 100;

        if (annualSavings <= 0 && portfolio < fiNumber && r <= 0) {
            fiAgeValue.innerText = "Never";
            if (fireChartInst) {
                fireChartInst.destroy();
                fireChartInst = null;
            }
            return;
        }

        let currentAge = age;
        let ages =[currentAge];
        let balances = [portfolio];

        while (portfolio < fiNumber && currentAge < 100) {
            portfolio = portfolio * (1 + r) + annualSavings;
            currentAge++;
            ages.push(currentAge);
            balances.push(portfolio);
        }

        if (portfolio >= fiNumber) {
            fiAgeValue.innerText = currentAge;
        } else {
            fiAgeValue.innerText = "100+";
        }

        if (fireChartInst) fireChartInst.destroy();

        const fireCtx = document.getElementById('fireChart').getContext('2d');
        fireChartInst = new Chart(fireCtx, {
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

    fireContributionInput.addEventListener("input", function() {
        userEditedFIRE = true;
        calculateFIRE();
    });
    currentPortfolioInput.addEventListener("input", calculateFIRE);
    marketReturnInput.addEventListener("input", calculateFIRE);
    inflationRateInput.addEventListener("input", calculateFIRE);

    function getPercentile(data, ht, sx, ed, rc, income) {
        if (!data || !data.demographics || !data.demographics[ht] || !data.demographics[ht][sx] || !data.demographics[ht][sx][ed] || !data.demographics[ht][sx][ed][rc]) return null;
        const brackets = data.demographics[ht][sx][ed][rc];
        const match = brackets.find(b => b.income >= income);
        return match ? match.percentile : 99;
    }

    calculateBtn.addEventListener("click", async function() {
        let baseIncomeRaw = parseFloat(baseIncomeInput.value) || 0;
        let taxExemptMonthly = parseFloat(taxExemptIncomeInput.value) || 0;
        currentTaxExempt = taxExemptMonthly;
        let existingDebt = parseFloat(monthlyDebtInput.value) || 0;
        let hours = parseFloat(hoursPerWeekInput.value) || 40;
        
        const location = locationSelect.value;
        const ht = householdTypeSelect.value;
        const sx = sexSelect.value;
        const ed = educationSelect.value;
        const rc = raceSelect.value;

        let taxableMonthlyGross = 0;
        let annualGross = 0;

        if (currentIncomeType === "annual") {
            taxableMonthlyGross = baseIncomeRaw / 12;
            annualGross = baseIncomeRaw;
        } else if (currentIncomeType === "monthly") {
            taxableMonthlyGross = baseIncomeRaw;
            annualGross = baseIncomeRaw * 12;
        } else if (currentIncomeType === "hourly") {
            taxableMonthlyGross = (baseIncomeRaw * hours * 52) / 12;
            annualGross = baseIncomeRaw * hours * 52;
        }

        currentCalculatedTotalGross = taxableMonthlyGross + taxExemptMonthly;
        
        let fetchedData = null;
        try {
            const response = await fetch(`data/${location}.json`);
            fetchedData = await response.json();
        } catch (error) {}

        currentTaxRate = fetchedData ? fetchedData.tax_rate : 0.22;
        
        const netTaxableIncome = taxableMonthlyGross * (1 - currentTaxRate);
        const totalNetMonthly = netTaxableIncome + taxExemptMonthly;
        
        let needsRatio = 0.50;
        let wantsRatio = 0.30;
        let savingsRatio = 0.20;

        if (location === "ca" || location === "ny") {
            needsRatio = 0.65;
            wantsRatio = 0.15;
            savingsRatio = 0.20;
            budgetTitle.innerText = `65/15/20 Budgeting Framework (HCOL Adjusted)`;
            labelNeeds.innerText = `Needs (65%)`;
            labelWants.innerText = `Wants (15%)`;
            labelSavings.innerText = `Savings & Debt (20%)`;
        } else {
            budgetTitle.innerText = `50/30/20 Budgeting Framework`;
            labelNeeds.innerText = `Needs (50%)`;
            labelWants.innerText = `Wants (30%)`;
            labelSavings.innerText = `Savings & Debt (20%)`;
        }

        currentCalculatedNeeds = totalNetMonthly * needsRatio;
        currentCalculatedWants = totalNetMonthly * wantsRatio;
        currentCalculatedSavings = totalNetMonthly * savingsRatio;

        currentCalculatedHousingMax = currentCalculatedTotalGross * 0.28;
        const totalDebtMax = currentCalculatedTotalGross * 0.36;
        const remainingDebtCapacity = Math.max(0, totalDebtMax - currentCalculatedHousingMax - existingDebt);
        
        let microP = getPercentile(fetchedData, ht, sx, ed, rc, annualGross);
        let macroP = getPercentile(fetchedData, 'all', 'all', 'all', 'all', annualGross);
        let sexP = getPercentile(fetchedData, 'all', sx, 'all', 'all', annualGross);
        let raceP = getPercentile(fetchedData, 'all', 'all', 'all', rc, annualGross);
        
        let fallbackP = Math.max(1, 100 - Math.floor(currentCalculatedTotalGross / 150));
        microP = microP || fallbackP;
        macroP = macroP || fallbackP;
        sexP = sexP || fallbackP;
        raceP = raceP || fallbackP;

        percentileValue.innerText = `Top ${microP}%`;
        
        let details = `Overall: Top ${macroP}% National`;
        if (sx !== 'all') details += ` • Top ${sexP}% of ${sexSelect.options[sexSelect.selectedIndex].text}`;
        if (rc !== 'all') details += ` • Top ${raceP}% of ${raceSelect.options[raceSelect.selectedIndex].text}`;
        
        detailedPercentiles.innerText = details;

        netIncomeValue.innerText = formatCurrency(totalNetMonthly);
        
        budgetNeeds.innerText = formatCurrency(currentCalculatedNeeds);
        budgetWants.innerText = formatCurrency(currentCalculatedWants);
        budgetSavings.innerText = formatCurrency(currentCalculatedSavings);

        if (!userEditedFIRE) {
            fireContributionInput.value = Math.round(currentCalculatedSavings);
        }

        maxHousing.innerText = formatCurrency(currentCalculatedHousingMax);
        maxTotalDebt.innerText = formatCurrency(totalDebtMax);
        availableDebtCapacity.innerText = formatCurrency(remainingDebtCapacity);

        calculateAuto();
        calculateHousingMatrix();
        updateLifestyleTracker();
        calculateGeoArbitrage();
        drawCharts(microP, currentCalculatedNeeds, currentCalculatedWants, currentCalculatedSavings);
        calculateFIRE();

        setupView.classList.remove("active-view");
        setupView.classList.add("hidden-view");
        resultsView.classList.remove("hidden-view");
        resultsView.classList.add("active-view");
        window.scrollTo(0, 0);
    });

    backBtn.addEventListener("click", function() {
        resultsView.classList.remove("active-view");
        resultsView.classList.add("hidden-view");
        setupView.classList.remove("hidden-view");
        setupView.classList.add("active-view");
        window.scrollTo(0, 0);
    });
});
