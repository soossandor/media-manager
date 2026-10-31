import { useState, useEffect } from 'react';
import { auth, googleProvider } from './firebase';
import {
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    GoogleAuthProvider,
    type User
} from 'firebase/auth';

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
}

export default function App() {
    const [user, setUser] = useState<User | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(() => {
        return sessionStorage.getItem('drive_access_token');
    });
    const [loading, setLoading] = useState(true);
    const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
    const [fetchingFiles, setFetchingFiles] = useState(false);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            if (!currentUser) {
                setAccessToken(null);
                sessionStorage.removeItem('drive_access_token');
                setDriveFiles([]);
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);

    const handleLogin = async () => {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            const credential = GoogleAuthProvider.credentialFromResult(result);
            const token = credential?.accessToken || null;

            if (token) {
                setAccessToken(token);
                sessionStorage.setItem('drive_access_token', token);
            }
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

    const loadDriveFiles = async () => {
        if (!accessToken) {
            alert('Nincs érvényes hozzáférési token. Jelentkezz be újra!');
            return;
        }

        setFetchingFiles(true);
        try {
            const response = await fetch(
                'https://www.googleapis.com/drive/v3/files?pageSize=15&fields=files(id,name,mimeType)',
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`API hiba: ${response.statusText}`);
            }

            const data = await response.json();
            setDriveFiles(data.files || []);
        } catch (error) {
            console.error('Drive lekérdezési hiba:', error);
            alert('Nem sikerült lekérni a fájlokat. Ellenőrizd a konzolt a részletekért!');
        } finally {
            setFetchingFiles(false);
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
        <div className="min-h-screen bg-slate-900 text-white p-6">
            <header className="max-w-4xl mx-auto flex items-center justify-between pb-6 border-b border-slate-800">
                <h1 className="text-2xl font-bold text-sky-400">Media Manager</h1>

                {user ? (
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                            {user.photoURL && (
                                <img
                                    src={user.photoURL}
                                    alt={user.displayName || 'Felhasználó'}
                                    className="w-9 h-9 rounded-full border border-sky-400"
                                />
                            )}
                            <span className="text-sm font-medium text-slate-300 hidden sm:inline">
                {user.displayName}
              </span>
                        </div>
                        <button
                            onClick={handleLogout}
                            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-sm font-medium rounded-md transition-colors cursor-pointer"
                        >
                            Kijelentkezés
                        </button>
                    </div>
                ) : null}
            </header>

            <main className="max-w-4xl mx-auto mt-8">
                {!user ? (
                    <div className="text-center py-20 bg-slate-800 rounded-xl border border-slate-700 max-w-md mx-auto">
                        <p className="text-slate-300 mb-6">A Google Drive fájljaid eléréséhez jelentkezz be.</p>
                        <button
                            onClick={handleLogin}
                            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            Bejelentkezés Google-fiókkal
                        </button>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="flex items-center justify-between bg-slate-800 p-4 rounded-xl border border-slate-700">
                            <div>
                                <h2 className="text-lg font-semibold text-slate-100">Google Drive kapcsolat</h2>
                                <p className="text-sm text-slate-400">
                                    {accessToken ? 'Token aktív a munkamenetben.' : 'Nincs token, jelentkezz be újra!'}
                                </p>
                            </div>
                            <button
                                onClick={loadDriveFiles}
                                disabled={fetchingFiles || !accessToken}
                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 font-medium rounded-lg transition-colors cursor-pointer"
                            >
                                {fetchingFiles ? 'Betöltés...' : 'Fájlok listázása'}
                            </button>
                        </div>

                        {driveFiles.length > 0 && (
                            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                                <div className="p-4 border-b border-slate-700 font-semibold text-slate-200">
                                    Drive elemek ({driveFiles.length})
                                </div>
                                <ul className="divide-y divide-slate-700/60 max-h-96 overflow-y-auto">
                                    {driveFiles.map((file) => (
                                        <li key={file.id} className="p-3.5 flex items-center justify-between hover:bg-slate-750">
                                            <div className="truncate mr-4">
                                                <p className="text-sm font-medium text-slate-200 truncate">{file.name}</p>
                                                <p className="text-xs text-slate-400 font-mono truncate">{file.mimeType}</p>
                                            </div>
                                            <span className="text-xs text-slate-500 shrink-0 font-mono">
                        {file.id.slice(0, 8)}...
                      </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
            </main>
        </div>
    );
}