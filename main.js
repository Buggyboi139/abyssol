document.addEventListener("DOMContentLoaded", function() {
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
    
    const percentileValue = document.getElementById("percentileValue");
    const netIncomeValue = document.getElementById("netIncomeValue");
    
    const budgetTitle = document.getElementById("budgetTitle");
    const labelNeeds = document.getElementById("labelNeeds");
    const labelWants = document.getElementById("labelWants");
    const labelSavings = document.getElementById("labelSavings");
    const budgetNeeds = document.getElementById("budgetNeeds");
    const budgetWants = document.getElementById("budgetWants");
    const budgetSavings = document.getElementById("budgetSavings");
    
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
    const maxHomePriceValue = document.getElementById("maxHomePriceValue");

    let currentCalculatedTotalGross = 0;
    let currentCalculatedHousingMax = 0;

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

        const monthlyPropertyTaxRate = 0.012 / 12;
        const monthlyInsuranceRate = 0.005 / 12;

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

    loanTypeSelect.addEventListener("change", calculateHousingMatrix);
    loanTermSelect.addEventListener("change", calculateHousingMatrix);
    interestRateSlider.addEventListener("input", function() {
        rateLabel.innerText = `${parseFloat(this.value).toFixed(1)}%`;
        calculateHousingMatrix();
    });
    downPaymentSlider.addEventListener("input", function() {
        downLabel.innerText = `${this.value}%`;
        calculateHousingMatrix();
    });

    calculateBtn.addEventListener("click", function() {
        let baseIncomeRaw = parseFloat(baseIncomeInput.value) || 0;
        let taxExemptMonthly = parseFloat(taxExemptIncomeInput.value) || 0;
        let existingDebt = parseFloat(monthlyDebtInput.value) || 0;
        let hours = parseFloat(hoursPerWeekInput.value) || 40;
        const location = locationSelect.value;

        let taxableMonthlyGross = 0;

        if (currentIncomeType === "annual") {
            taxableMonthlyGross = baseIncomeRaw / 12;
        } else if (currentIncomeType === "monthly") {
            taxableMonthlyGross = baseIncomeRaw;
        } else if (currentIncomeType === "hourly") {
            taxableMonthlyGross = (baseIncomeRaw * hours * 52) / 12;
        }

        currentCalculatedTotalGross = taxableMonthlyGross + taxExemptMonthly;
        
        const effectiveTaxRate = 0.22;
        const netTaxableIncome = taxableMonthlyGross * (1 - effectiveTaxRate);
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

        const needs = totalNetMonthly * needsRatio;
        const wants = totalNetMonthly * wantsRatio;
        const savings = totalNetMonthly * savingsRatio;

        currentCalculatedHousingMax = currentCalculatedTotalGross * 0.28;
        const totalDebtMax = currentCalculatedTotalGross * 0.36;
        const remainingDebtCapacity = Math.max(0, totalDebtMax - currentCalculatedHousingMax - existingDebt);

        const transportMax = currentCalculatedTotalGross * 0.10;
        
        const autoDownPaymentPct = 0.20;
        const autoTermMonths = 48;
        const autoMonthlyCapacity = transportMax;
        const estimatedCarPrice = (autoMonthlyCapacity * autoTermMonths) / (1 - autoDownPaymentPct);

        let percentile = 99;
        if (currentCalculatedTotalGross > 0) {
            percentile = Math.max(1, 100 - Math.floor(currentCalculatedTotalGross / 150));
        }

        percentileValue.innerText = `Top ${percentile}%`;
        netIncomeValue.innerText = formatCurrency(totalNetMonthly);
        
        budgetNeeds.innerText = formatCurrency(needs);
        budgetWants.innerText = formatCurrency(wants);
        budgetSavings.innerText = formatCurrency(savings);

        maxHousing.innerText = formatCurrency(currentCalculatedHousingMax);
        maxTotalDebt.innerText = formatCurrency(totalDebtMax);
        availableDebtCapacity.innerText = formatCurrency(remainingDebtCapacity);

        maxTransport.innerText = formatCurrency(transportMax);
        maxCarPrice.innerText = formatCurrency(estimatedCarPrice);

        calculateHousingMatrix();

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
