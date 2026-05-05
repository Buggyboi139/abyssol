document.addEventListener("DOMContentLoaded", function() {
    const calculateBtn = document.getElementById("calculateBtn");
    const backBtn = document.getElementById("backBtn");
    const setupView = document.getElementById("setup-view");
    const resultsView = document.getElementById("results-view");
    
    const grossIncomeInput = document.getElementById("grossIncome");
    const monthlyDebtInput = document.getElementById("monthlyDebt");
    
    const percentileValue = document.getElementById("percentileValue");
    const netIncomeValue = document.getElementById("netIncomeValue");
    
    const budgetNeeds = document.getElementById("budgetNeeds");
    const budgetWants = document.getElementById("budgetWants");
    const budgetSavings = document.getElementById("budgetSavings");
    
    const maxHousing = document.getElementById("maxHousing");
    const maxTotalDebt = document.getElementById("maxTotalDebt");
    const availableDebtCapacity = document.getElementById("availableDebtCapacity");
    
    const maxTransport = document.getElementById("maxTransport");
    const maxCarPrice = document.getElementById("maxCarPrice");

    function formatCurrency(amount) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0
        }).format(amount);
    }

    calculateBtn.addEventListener("click", function() {
        const grossIncome = parseFloat(grossIncomeInput.value) || 0;
        const existingDebt = parseFloat(monthlyDebtInput.value) || 0;

        const effectiveTaxRate = 0.22;
        const netIncome = grossIncome * (1 - effectiveTaxRate);
        
        const needs = netIncome * 0.50;
        const wants = netIncome * 0.30;
        const savings = netIncome * 0.20;

        const housingMax = grossIncome * 0.28;
        const totalDebtMax = grossIncome * 0.36;
        const remainingDebtCapacity = Math.max(0, totalDebtMax - housingMax - existingDebt);

        const transportMax = grossIncome * 0.10;
        
        const autoDownPaymentPct = 0.20;
        const autoTermMonths = 48;
        const autoMonthlyCapacity = transportMax;
        const estimatedCarPrice = (autoMonthlyCapacity * autoTermMonths) / (1 - autoDownPaymentPct);

        let percentile = 99;
        if (grossIncome > 0) {
            percentile = Math.max(1, 100 - Math.floor(grossIncome / 150));
        }

        percentileValue.innerText = `Top ${percentile}%`;
        netIncomeValue.innerText = formatCurrency(netIncome);
        
        budgetNeeds.innerText = formatCurrency(needs);
        budgetWants.innerText = formatCurrency(wants);
        budgetSavings.innerText = formatCurrency(savings);

        maxHousing.innerText = formatCurrency(housingMax);
        maxTotalDebt.innerText = formatCurrency(totalDebtMax);
        availableDebtCapacity.innerText = formatCurrency(remainingDebtCapacity);

        maxTransport.innerText = formatCurrency(transportMax);
        maxCarPrice.innerText = formatCurrency(estimatedCarPrice);

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
