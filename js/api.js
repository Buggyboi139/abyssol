export const supabase = window.supabase.createClient(
    'https://agfngkzohlrmxjhysafn.supabase.co',
    'sb_publishable_8u_PB-tndXrjSe9TNu_G7A_GKQjBxD0'
);

export async function fetchMarketData(state) {
    try {
        const { data } = await supabase.from('macro_data').select('*').order('date', { ascending: false }).limit(1);
        if (data && data.length > 0) {
            state.marketRates.mortgage_30yr = data[0].fred_mortgage_30yr || state.marketRates.mortgage_30yr;
            state.marketRates.auto_new = data[0].fred_auto_new || state.marketRates.auto_new;
            state.marketRates.inflation_cpi = data[0].fred_inflation || state.marketRates.inflation_cpi;
        }
    } catch (e) {}
}

export async function fetchLocationData(loc) {
    try {
        const res = await fetch(`data/${loc}.json`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        return null;
    }
}

export async function fetchUserProfile(userId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    return data;
}

export async function saveUserProfile(userId, profileData) {
    const payload = { id: userId, ...profileData, updated_at: new Date() };
    await supabase.from('profiles').upsert(payload);
}

export async function fetchTransactions(userId) {
    const { data } = await supabase.from('transactions').select('*').eq('user_id', userId).order('date', { ascending: false });
    return data ||[];
}