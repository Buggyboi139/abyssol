export const state = {
    user: null,
    profileLoaded: false,
    isHydrating: false,
    income: 0,
    taxFreeIncome: 0,
    sharedContribution: 0,
    portfolio: 0,
    creditScore: 720,
    age: 25,
    location: 'national',
    householdType: 'all',
    sex: 'all',
    education: 'all',
    race: 'all',
    transactions:[],
    marketRates: {
        mortgage_30yr: 6.85,
        auto_new: 7.20,
        inflation_cpi: 3.1
    },
    locationData: null,
    compareLocationData: null,
    filters: {
        dateRange: 'all',
        category: 'all'
    },
    activeView: 'timeline'
};