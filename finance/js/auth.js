import { supabase, fetchUserProfile, fetchTransactions } from './api.js';
import { state } from './state.js';
import { hydrateUI, triggerCalculations, renderStatementList } from './ui.js';

let lastHandledUserId = null;

export async function initAuth() {
    supabase.auth.onAuthStateChange((event, session) => handleAuthChange(session));

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
                alert('Registration successful. Check your email to confirm.');
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) {
            const banner = document.getElementById('authErrorBanner');
            banner.textContent = err.message;
            banner.classList.add('visible');
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

    if (!session) {
        state.user = null;
        state.profileLoaded = false;
        lastHandledUserId = null;
        overlay.classList.remove('hidden');
        wrapper.classList.add('hidden');
        return;
    }

    state.user = session.user;
    overlay.classList.add('hidden');
    wrapper.classList.remove('hidden');

    if (lastHandledUserId === session.user.id) return;
    lastHandledUserId = session.user.id;

    state.isHydrating = true;
    try {
        const { profile, isNewUser } = await fetchUserProfile(state.user.id);
        state.transactions = await fetchTransactions(state.user.id);
        if (profile) {
            hydrateUI(profile);
        }
        state.profileLoaded = true;
        state.isNewUser = isNewUser;
        await triggerCalculations({ skipSave: isNewUser });
        renderStatementList();
    } finally {
        state.isHydrating = false;
    }
}
