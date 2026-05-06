import { supabase, fetchUserProfile, fetchTransactions } from './api.js';
import { state } from './state.js';
import { hydrateUI, triggerCalculations } from './ui.js';

export async function initAuth() {
    supabase.auth.onAuthStateChange((event, session) => handleAuthChange(session));
    const { data: { session } } = await supabase.auth.getSession();
    handleAuthChange(session);
    
    document.getElementById('authForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('authEmail').value;
        const password = document.getElementById('authPassword').value;
        const btn = document.getElementById('authSubmitBtn');
        const isReg = btn.dataset.mode === 'register';
        btn.disabled = true;
        
        try {
            if (isReg) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                alert('Registration successful.');
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) {
            document.getElementById('authErrorBanner').textContent = err.message;
            document.getElementById('authErrorBanner').classList.add('visible');
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('authToggleBtn').addEventListener('click', (e) => {
        const btn = document.getElementById('authSubmitBtn');
        const isReg = btn.dataset.mode === 'register';
        btn.dataset.mode = isReg ? 'login' : 'register';
        btn.textContent = isReg ? 'Sign In' : 'Sign Up';
        e.target.textContent = isReg ? 'Create an account' : 'Already have an account? Sign in';
        document.getElementById('authErrorBanner').classList.remove('visible');
    });

    document.getElementById('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
}

async function handleAuthChange(session) {
    const overlay = document.getElementById('auth-overlay');
    const wrapper = document.getElementById('appWrapper');
    if (session) {
        state.user = session.user;
        overlay.classList.add('hidden');
        wrapper.classList.remove('hidden');
        const profile = await fetchUserProfile(state.user.id);
        state.transactions = await fetchTransactions(state.user.id);
        if (profile) hydrateUI(profile);
        triggerCalculations();
    } else {
        state.user = null;
        overlay.classList.remove('hidden');
        wrapper.classList.add('hidden');
    }
}