import { useState, useEffect } from 'react';
import { auth, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, type User } from 'firebase/auth';

export default function App() {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);

    const handleLogin = async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error) {
            console.error('Bejelentkezési hiba:', error);
        }
    };

    const handleLogout = async () => {
        try {
            await signOut(auth);
        } catch (error) {
            console.error('Kijelentkezési hiba:', error);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
                <p className="text-slate-400">Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
            <div className="p-8 bg-slate-800 rounded-xl shadow-lg text-center max-w-md w-full border border-slate-700">
                <h1 className="text-3xl font-bold text-sky-400">Media Manager</h1>

                {user ? (
                    <div className="mt-6 flex flex-col items-center">
                        {user.photoURL && (
                            <img
                                src={user.photoURL}
                                alt={user.displayName || 'Felhasználó'}
                                className="w-16 h-16 rounded-full border-2 border-sky-400 mb-3"
                            />
                        )}
                        <p className="text-lg font-medium text-slate-200">{user.displayName}</p>
                        <p className="text-sm text-slate-400">{user.email}</p>
                        <button
                            onClick={handleLogout}
                            className="mt-6 px-4 py-2 bg-rose-600 hover:bg-rose-700 font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            Kijelentkezés
                        </button>
                    </div>
                ) : (
                    <div className="mt-6">
                        <p className="text-slate-300 mb-6">A folytatáshoz jelentkezz be a Google-fiókoddal.</p>
                        <button
                            onClick={handleLogin}
                            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 font-semibold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 mx-auto"
                        >
                            Bejelentkezés Google-fiókkal
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}