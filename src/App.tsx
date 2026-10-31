import { useState, useEffect, useCallback } from 'react';
import { auth, googleProvider, db } from './firebase';
import {
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    GoogleAuthProvider,
    type User
} from 'firebase/auth';
import {
    doc,
    getDoc,
    setDoc,
    writeBatch,
    arrayUnion,
    arrayRemove,
    serverTimestamp
} from 'firebase/firestore';

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    webViewLink?: string;
    size?: string;
    createdTime?: string;
}

interface DriveFolder {
    id: string;
    name: string;
}

interface BreadcrumbItem {
    id: string;
    name: string;
}

interface MediaMeta {
    tags: string[];
    note: string;
    isFavorite: boolean;
}

type GridDensity = 'sm' | 'md' | 'lg';

function MediaThumbnail({ src, alt }: { src?: string; alt: string }) {
    const [hasError, setHasError] = useState(false);

    if (!src || hasError) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-slate-500 gap-1.5 p-3 text-center">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-7 h-7 opacity-60"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
                    />
                </svg>
                <span className="text-[11px] font-medium">Nincs előnézet</span>
            </div>
        );
    }

    return (
        <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setHasError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
        />
    );
}

export default function App() {
    const [user, setUser] = useState<User | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(() => {
        return sessionStorage.getItem('drive_access_token');
    });
    const [loading, setLoading] = useState(true);

    // Fájlok és szűrés
    const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
    const [fetchingFiles, setFetchingFiles] = useState(false);
    const [filterType, setFilterType] = useState<'all' | 'image' | 'video'>('all');

    // Rácsméret (kicsi / közepes / nagy)
    const [gridDensity, setGridDensity] = useState<GridDensity>('md');

    // Nézeti mód és Mappa navigáció
    const [viewMode, setViewMode] = useState<'folder' | 'all'>('folder');
    const [currentFolder, setCurrentFolder] = useState<BreadcrumbItem>({
        id: 'root',
        name: 'Saját meghajtó',
    });
    const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
        { id: 'root', name: 'Saját meghajtó' },
    ]);
    const [subfolders, setSubfolders] = useState<DriveFolder[]>([]);
    const [fetchingFolders, setFetchingFolders] = useState(false);
    const [isRecursive, setIsRecursive] = useState(false);

    // Kijelölési állapot
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

    // Globális Címketár (Tag Pool)
    const [tagPool, setTagPool] = useState<string[]>([]);

    // Egyéni metaadat ablak
    const [activeFile, setActiveFile] = useState<DriveFile | null>(null);
    const [metaLoading, setMetaLoading] = useState(false);
    const [metaSaving, setMetaSaving] = useState(false);
    const [tagInput, setTagInput] = useState('');
    const [currentMeta, setCurrentMeta] = useState<MediaMeta>({
        tags: [],
        note: '',
        isFavorite: false,
    });

    // Tömeges módosító ablak
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [bulkTagsToAdd, setBulkTagsToAdd] = useState<string[]>([]);
    const [bulkTagsToRemove, setBulkTagsToRemove] = useState<string[]>([]);
    const [bulkTagInput, setBulkTagInput] = useState('');
    const [bulkSaving, setBulkSaving] = useState(false);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            setUser(currentUser);
            if (!currentUser) {
                setAccessToken(null);
                sessionStorage.removeItem('drive_access_token');
                setDriveFiles([]);
                setSelectedFileIds([]);
                setActiveFile(null);
                setTagPool([]);
            } else {
                try {
                    const poolDoc = await getDoc(doc(db, 'users', currentUser.uid, 'settings', 'tagPool'));
                    if (poolDoc.exists()) {
                        setTagPool(poolDoc.data().tags || []);
                    }
                } catch (err) {
                    console.error('Címketár betöltési hiba:', err);
                }
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);

    const handleLoginOrRefreshToken = async () => {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            const credential = GoogleAuthProvider.credentialFromResult(result);
            const token = credential?.accessToken || null;

            if (token) {
                setAccessToken(token);
                sessionStorage.setItem('drive_access_token', token);
                return token;
            }
        } catch (error) {
            console.error('Bejelentkezési hiba:', error);
            alert('Nem sikerült a bejelentkezés / token frissítés.');
        }
        return null;
    };

    const handleLogout = async () => {
        try {
            await signOut(auth);
        } catch (error) {
            console.error('Kijelentkezési hiba:', error);
        }
    };

    const loadSubfolders = useCallback(async (folderId: string) => {
        if (!accessToken) return;
        setFetchingFolders(true);
        try {
            const params = new URLSearchParams({
                pageSize: '100',
                q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id,name)',
                orderBy: 'name',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });

            const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (response.ok) {
                const data = await response.json();
                setSubfolders(data.files || []);
            }
        } catch (err) {
            console.error('Almappák betöltési hiba:', err);
        } finally {
            setFetchingFolders(false);
        }
    }, [accessToken]);

    const collectFolderIdsRecursively = async (startFolderId: string): Promise<string[]> => {
        if (!accessToken) return [startFolderId];
        const allFolderIds: string[] = [startFolderId];
        const queue: string[] = [startFolderId];

        while (queue.length > 0) {
            const parentId = queue.shift()!;
            const params = new URLSearchParams({
                pageSize: '100',
                q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id)',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });

            try {
                const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                if (response.ok) {
                    const data = await response.json();
                    const childIds = (data.files || []).map((f: { id: string }) => f.id);
                    allFolderIds.push(...childIds);
                    queue.push(...childIds);
                }
            } catch (e) {
                console.error('Rekurzív mappa gyűjtési hiba:', e);
            }
        }

        return allFolderIds;
    };

    const loadMediaFiles = async () => {
        let currentToken = accessToken;
        if (!currentToken) {
            currentToken = await handleLoginOrRefreshToken();
            if (!currentToken) return;
        }

        setFetchingFiles(true);
        setSelectedFileIds([]);

        try {
            let typeFilter = "(mimeType contains 'image/' or mimeType contains 'video/')";
            if (filterType === 'image') typeFilter = "mimeType contains 'image/'";
            if (filterType === 'video') typeFilter = "mimeType contains 'video/'";

            const fieldsMask = 'files(id,name,mimeType,thumbnailLink,webViewLink,size,createdTime)';

            if (viewMode === 'all') {
                const q = `trashed = false and ${typeFilter}`;
                const params = new URLSearchParams({
                    pageSize: '100',
                    q,
                    fields: fieldsMask,
                    supportsAllDrives: 'true',
                    includeItemsFromAllDrives: 'true',
                });

                const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                    headers: { Authorization: `Bearer ${currentToken}` },
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => null);
                    const message = errData?.error?.message || response.statusText;
                    if (response.status === 401) {
                        alert('A Google munkamenet (token) lejárt! Kattints a jobb felső sarokban a „Drive frissítése” gombra.');
                        return;
                    }
                    throw new Error(`Google API hiba (${response.status}): ${message}`);
                }

                const data = await response.json();
                setDriveFiles(data.files || []);
            } else {
                if (isRecursive) {
                    const folderIds = await collectFolderIdsRecursively(currentFolder.id);
                    const chunkSize = 15;
                    const collectedFiles: DriveFile[] = [];

                    for (let i = 0; i < folderIds.length; i += chunkSize) {
                        const chunk = folderIds.slice(i, i + chunkSize);
                        const parentQueries = chunk.map((id) => `'${id}' in parents`).join(' or ');
                        const q = `trashed = false and (${parentQueries}) and ${typeFilter}`;

                        const params = new URLSearchParams({
                            pageSize: '100',
                            q,
                            fields: fieldsMask,
                            supportsAllDrives: 'true',
                            includeItemsFromAllDrives: 'true',
                        });

                        const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                            headers: { Authorization: `Bearer ${currentToken}` },
                        });

                        if (response.ok) {
                            const data = await response.json();
                            collectedFiles.push(...(data.files || []));
                        }
                    }

                    setDriveFiles(collectedFiles);
                } else {
                    const q = `trashed = false and '${currentFolder.id}' in parents and ${typeFilter}`;
                    const params = new URLSearchParams({
                        pageSize: '100',
                        q,
                        fields: fieldsMask,
                        supportsAllDrives: 'true',
                        includeItemsFromAllDrives: 'true',
                    });

                    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                        headers: { Authorization: `Bearer ${currentToken}` },
                    });

                    if (!response.ok) {
                        const errData = await response.json().catch(() => null);
                        const message = errData?.error?.message || response.statusText;
                        if (response.status === 401) {
                            alert('A Google munkamenet (token) lejárt! Kattints a jobb felső sarokban a „Drive frissítése” gombra.');
                            return;
                        }
                        throw new Error(`Google API hiba (${response.status}): ${message}`);
                    }

                    const data = await response.json();
                    setDriveFiles(data.files || []);
                }
            }
        } catch (error: unknown) {
            console.error('Drive lekérdezési hiba:', error);
            const msg = error instanceof Error ? error.message : 'Ismeretlen hiba történt.';
            alert(msg);
        } finally {
            setFetchingFiles(false);
        }
    };

    const handleEnterFolder = (folder: DriveFolder) => {
        const nextBreadcrumb = { id: folder.id, name: folder.name };
        setCurrentFolder(nextBreadcrumb);
        setBreadcrumbs((prev) => [...prev, nextBreadcrumb]);
    };

    const handleJumpToBreadcrumb = (index: number) => {
        const target = breadcrumbs[index];
        setCurrentFolder(target);
        setBreadcrumbs((prev) => prev.slice(0, index + 1));
    };

    useEffect(() => {
        if (user && accessToken && viewMode === 'folder') {
            loadSubfolders(currentFolder.id);
        }
    }, [user, accessToken, currentFolder, viewMode, loadSubfolders]);

    const toggleSelectFile = (id: string) => {
        setSelectedFileIds((prev) =>
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
        );
    };

    const handleSelectAll = () => {
        if (selectedFileIds.length === driveFiles.length) {
            setSelectedFileIds([]);
        } else {
            setSelectedFileIds(driveFiles.map((f) => f.id));
        }
    };

    const registerNewTagToPool = async (tag: string) => {
        const cleanTag = tag.trim().toLowerCase();
        if (!cleanTag || !user) return cleanTag;

        if (!tagPool.includes(cleanTag)) {
            setTagPool((prev) => [...prev, cleanTag]);
            try {
                await setDoc(
                    doc(db, 'users', user.uid, 'settings', 'tagPool'),
                    { tags: arrayUnion(cleanTag) },
                    { merge: true }
                );
            } catch (err) {
                console.error('Címke pool mentési hiba:', err);
            }
        }
        return cleanTag;
    };

    const openMetadataModal = async (file: DriveFile) => {
        setActiveFile(file);
        setMetaLoading(true);
        setTagInput('');

        if (!user) return;

        try {
            const docRef = doc(db, 'users', user.uid, 'media', file.id);
            const docSnap = await getDoc(docRef);

            if (docSnap.exists()) {
                const data = docSnap.data();
                setCurrentMeta({
                    tags: data.tags || [],
                    note: data.note || '',
                    isFavorite: data.isFavorite || false,
                });
            } else {
                setCurrentMeta({
                    tags: [],
                    note: '',
                    isFavorite: false,
                });
            }
        } catch (error) {
            console.error('Hiba a metaadat betöltésekor:', error);
        } finally {
            setMetaLoading(false);
        }
    };

    const handleAddTagToCurrent = async (tag: string) => {
        const cleanTag = await registerNewTagToPool(tag);
        if (cleanTag && !currentMeta.tags.includes(cleanTag)) {
            setCurrentMeta((prev) => ({
                ...prev,
                tags: [...prev.tags, cleanTag],
            }));
            setTagInput('');
        }
    };

    const handleRemoveTagFromCurrent = (tagToRemove: string) => {
        setCurrentMeta((prev) => ({
            ...prev,
            tags: prev.tags.filter((t) => t !== tagToRemove),
        }));
    };

    const handleSaveMetadata = async () => {
        if (!user || !activeFile) return;

        setMetaSaving(true);
        try {
            const docRef = doc(db, 'users', user.uid, 'media', activeFile.id);
            await setDoc(
                docRef,
                {
                    fileName: activeFile.name,
                    mimeType: activeFile.mimeType,
                    tags: currentMeta.tags,
                    note: currentMeta.note,
                    isFavorite: currentMeta.isFavorite,
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            setActiveFile(null);
        } catch (error) {
            console.error('Hiba a mentés során:', error);
            alert('Nem sikerült menteni a metaadatokat.');
        } finally {
            setMetaSaving(false);
        }
    };

    const openBulkModal = () => {
        setBulkTagsToAdd([]);
        setBulkTagsToRemove([]);
        setBulkTagInput('');
        setIsBulkModalOpen(true);
    };

    const handleExecuteBulkTags = async () => {
        if (!user || selectedFileIds.length === 0) return;
        if (bulkTagsToAdd.length === 0 && bulkTagsToRemove.length === 0) {
            alert('Nincs kiválasztva sem hozzáadandó, sem eltávolítandó címke.');
            return;
        }

        setBulkSaving(true);
        try {
            const batch = writeBatch(db);

            selectedFileIds.forEach((fileId) => {
                const fileRef = doc(db, 'users', user.uid, 'media', fileId);
                const updates: Record<string, unknown> = {
                    updatedAt: serverTimestamp(),
                };

                if (bulkTagsToAdd.length > 0) {
                    updates.tags = arrayUnion(...bulkTagsToAdd);
                }
                if (bulkTagsToRemove.length > 0) {
                    updates.tags = arrayRemove(...bulkTagsToRemove);
                }

                batch.set(fileRef, updates, { merge: true });
            });

            await batch.commit();
            setIsBulkModalOpen(false);
            setSelectedFileIds([]);
            alert(`Sikeresen frissítve ${selectedFileIds.length} fájl címkéje!`);
        } catch (error) {
            console.error('Tömeges frissítési hiba:', error);
            alert('Hiba történt a tömeges címkézés során.');
        } finally {
            setBulkSaving(false);
        }
    };

    const handleBulkFavoriteToggle = async (markAsFavorite: boolean) => {
        if (!user || selectedFileIds.length === 0) return;

        try {
            const batch = writeBatch(db);
            selectedFileIds.forEach((fileId) => {
                const fileRef = doc(db, 'users', user.uid, 'media', fileId);
                batch.set(
                    fileRef,
                    {
                        isFavorite: markAsFavorite,
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );
            });
            await batch.commit();
            alert(`${selectedFileIds.length} fájl állapota frissítve!`);
            setSelectedFileIds([]);
        } catch (err) {
            console.error('Hiba a tömeges kedvenc beállításakor:', err);
        }
    };

    const formatFileSize = (bytes?: string) => {
        if (!bytes) return '–';
        const size = parseInt(bytes, 10);
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    };

    // Dinamikus rácsosztályok
    const gridClasses = {
        sm: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3',
        md: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4',
        lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6',
    }[gridDensity];

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
                <p className="text-slate-400">Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-900 text-white p-6 pb-24">
            {/* Fejléc */}
            <header className="max-w-7xl mx-auto flex items-center justify-between pb-6 border-b border-slate-800">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-sky-500 rounded-lg flex items-center justify-center font-bold text-slate-950">
                        M
                    </div>
                    <h1 className="text-2xl font-bold text-sky-400">Media Manager</h1>
                </div>

                {user ? (
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2.5">
                            {user.photoURL && (
                                <img
                                    src={user.photoURL}
                                    alt={user.displayName || 'Profilkép'}
                                    referrerPolicy="no-referrer"
                                    className="w-9 h-9 rounded-full border border-sky-400 object-cover"
                                />
                            )}
                            <span className="text-sm font-medium text-slate-300 hidden sm:inline">
                {user.displayName}
              </span>
                        </div>

                        <button
                            onClick={handleLoginOrRefreshToken}
                            title="Ha lejárt a kapcsolat, kattints ide a frissítéshez"
                            className="px-3 py-1.5 bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 border border-sky-500/40 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            🔄 Drive frissítése
                        </button>

                        <button
                            onClick={handleLogout}
                            className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-sm font-medium rounded-lg transition-colors cursor-pointer"
                        >
                            Kijelentkezés
                        </button>
                    </div>
                ) : null}
            </header>

            {/* Fő tartalom */}
            <main className="max-w-7xl mx-auto mt-8">
                {!user ? (
                    <div className="text-center py-20 bg-slate-800 rounded-2xl border border-slate-700 max-w-md mx-auto shadow-xl">
                        <h2 className="text-xl font-semibold mb-2">Üdvözöl a Media Manager!</h2>
                        <p className="text-slate-400 mb-6 text-sm">
                            Jelentkezz be Google-fiókoddal a Drive-on tárolt médiafájljaid kezeléséhez.
                        </p>
                        <button
                            onClick={handleLoginOrRefreshToken}
                            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            Bejelentkezés Google-fiókkal
                        </button>
                    </div>
                ) : (
                    <div className="space-y-6">
                        {/* Navigációs és Nézetmód Kapcsoló */}
                        <div className="bg-slate-800/80 backdrop-blur p-4 rounded-xl border border-slate-700 space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-4">
                                {/* Módváltó (Mappák vs Összes) */}
                                <div className="flex items-center gap-2 bg-slate-900/60 p-1 rounded-lg border border-slate-700">
                                    <button
                                        onClick={() => setViewMode('folder')}
                                        className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            viewMode === 'folder'
                                                ? 'bg-sky-500 text-slate-950'
                                                : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        <span>📁</span> Mappák szerinti nézet
                                    </button>
                                    <button
                                        onClick={() => setViewMode('all')}
                                        className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            viewMode === 'all'
                                                ? 'bg-sky-500 text-slate-950'
                                                : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        <span>🌐</span> Teljes Drive
                                    </button>
                                </div>

                                {/* Szűrők, Rácsméret és Keresés gomb */}
                                <div className="flex flex-wrap items-center gap-3">
                                    {/* Típus szűrő */}
                                    <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-lg border border-slate-700">
                                        <button
                                            onClick={() => setFilterType('all')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                filterType === 'all' ? 'bg-slate-700 text-sky-400' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Mind
                                        </button>
                                        <button
                                            onClick={() => setFilterType('image')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                filterType === 'image' ? 'bg-slate-700 text-sky-400' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Képek
                                        </button>
                                        <button
                                            onClick={() => setFilterType('video')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                filterType === 'video' ? 'bg-slate-700 text-sky-400' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Videók
                                        </button>
                                    </div>

                                    {/* ÚJ: Rácsméret állító (Kicsi / Közepes / Nagy) */}
                                    <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-lg border border-slate-700">
                                        <span className="text-[11px] text-slate-400 px-1 font-medium hidden sm:inline">Rács:</span>
                                        <button
                                            onClick={() => setGridDensity('sm')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'sm' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                            title="Sűrű nézet (6 oszlop, sok kép egyszerre)"
                                        >
                                            Kicsi
                                        </button>
                                        <button
                                            onClick={() => setGridDensity('md')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'md' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                            title="Normál nézet (4 oszlop)"
                                        >
                                            Közepes
                                        </button>
                                        <button
                                            onClick={() => setGridDensity('lg')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'lg' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                            title="Nagy előnézeti nézet (2-3 oszlop, nagy kártyák)"
                                        >
                                            Nagy
                                        </button>
                                    </div>

                                    <button
                                        onClick={loadMediaFiles}
                                        disabled={fetchingFiles}
                                        className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 font-medium rounded-lg transition-colors cursor-pointer flex items-center gap-2 text-sm"
                                    >
                                        {fetchingFiles ? 'Betöltés...' : 'Fájlok beolvasása'}
                                    </button>
                                </div>
                            </div>

                            {/* Mappaszintű vezérlés */}
                            {viewMode === 'folder' && (
                                <div className="pt-3 border-t border-slate-700/60 space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/40 p-2.5 rounded-lg border border-slate-700/50">
                                        <div className="flex items-center gap-1.5 text-sm flex-wrap">
                                            <span className="text-xs text-slate-500 font-semibold uppercase mr-1">Útvonal:</span>
                                            {breadcrumbs.map((crumb, idx) => (
                                                <div key={crumb.id} className="flex items-center gap-1.5">
                                                    {idx > 0 && <span className="text-slate-600">/</span>}
                                                    <button
                                                        onClick={() => handleJumpToBreadcrumb(idx)}
                                                        className={`px-2 py-0.5 rounded text-xs transition-colors cursor-pointer ${
                                                            idx === breadcrumbs.length - 1
                                                                ? 'bg-sky-500/20 text-sky-300 font-semibold'
                                                                : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                                        }`}
                                                    >
                                                        {crumb.name}
                                                    </button>
                                                </div>
                                            ))}
                                        </div>

                                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300 select-none">
                                            <input
                                                type="checkbox"
                                                checked={isRecursive}
                                                onChange={(e) => setIsRecursive(e.target.checked)}
                                                className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
                                            />
                                            <span>Almappák fájljai is (rekurzív)</span>
                                        </label>
                                    </div>

                                    {/* Almappák gombjai */}
                                    <div>
                                        <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                        Almappák ezen a szinten ({subfolders.length})
                      </span>
                                            {fetchingFolders && (
                                                <span className="text-[11px] text-sky-400">Mappák keresése...</span>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto p-1">
                                            {subfolders.map((folder) => (
                                                <button
                                                    key={folder.id}
                                                    onClick={() => handleEnterFolder(folder)}
                                                    className="px-3 py-1.5 rounded-lg bg-slate-700/70 hover:bg-slate-700 text-slate-200 border border-slate-600 text-xs flex items-center gap-1.5 transition-all cursor-pointer group"
                                                >
                                                    <span className="group-hover:scale-110 transition-transform">📂</span>
                                                    <span className="truncate max-w-[160px]">{folder.name}</span>
                                                </button>
                                            ))}

                                            {!fetchingFolders && subfolders.length === 0 && (
                                                <span className="text-xs text-slate-500 italic p-1">
                          Nincsenek almappák ezen a szinten.
                        </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Számláló és gyors kijelölés */}
                        {driveFiles.length > 0 && (
                            <div className="flex items-center justify-between px-2">
                <span className="text-xs text-slate-400 font-medium">
                  Találatok száma: <strong className="text-slate-200">{driveFiles.length}</strong>
                </span>

                                <button
                                    onClick={handleSelectAll}
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                                >
                                    {selectedFileIds.length === driveFiles.length ? 'Kijelölés törlése' : 'Összes kijelölése'}
                                </button>
                            </div>
                        )}

                        {/* Fájlrács a kiválasztott sűrűséggel */}
                        {driveFiles.length > 0 ? (
                            <div className={`grid ${gridClasses}`}>
                                {driveFiles.map((file) => {
                                    const isVideo = file.mimeType.startsWith('video/');
                                    const isSelected = selectedFileIds.includes(file.id);
                                    const previewSrc = file.thumbnailLink
                                        ? file.thumbnailLink.replace(/=s\d+/, gridDensity === 'lg' ? '=s800' : '=s400')
                                        : undefined;

                                    return (
                                        <div
                                            key={file.id}
                                            className={`group bg-slate-800 rounded-xl border transition-all flex flex-col relative overflow-hidden ${
                                                isSelected ? 'border-sky-400 ring-2 ring-sky-500/50 bg-slate-800/90' : 'border-slate-700 hover:border-slate-500'
                                            }`}
                                        >
                                            <div className="aspect-video bg-slate-950 relative overflow-hidden flex items-center justify-center">
                                                <MediaThumbnail src={previewSrc} alt={file.name} />

                                                <label
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="absolute top-2 left-2 z-10 cursor-pointer p-1 rounded-md bg-slate-900/80 backdrop-blur border border-slate-700 flex items-center justify-center"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => toggleSelectFile(file.id)}
                                                        className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
                                                    />
                                                </label>

                                                <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-300">
                          {isVideo ? 'Videó' : 'Kép'}
                        </span>
                                            </div>

                                            <div className={`flex-1 flex flex-col justify-between ${gridDensity === 'sm' ? 'p-2.5' : 'p-3.5'}`}>
                                                <div>
                                                    <p className={`font-medium text-slate-200 truncate ${gridDensity === 'sm' ? 'text-xs' : 'text-sm'}`} title={file.name}>
                                                        {file.name}
                                                    </p>
                                                    <p className="text-[11px] text-slate-400 mt-1 flex justify-between">
                                                        <span>{formatFileSize(file.size)}</span>
                                                        <span>{file.createdTime ? new Date(file.createdTime).toLocaleDateString() : ''}</span>
                                                    </p>
                                                </div>

                                                <div className={`mt-2.5 pt-2.5 border-t border-slate-700/60 flex items-center justify-between ${gridDensity === 'sm' ? 'text-[11px]' : 'text-xs'}`}>
                                                    {file.webViewLink && (
                                                        <a
                                                            href={file.webViewLink}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="text-sky-400 hover:text-sky-300 font-medium"
                                                        >
                                                            Megnyitás ↗
                                                        </a>
                                                    )}
                                                    <button
                                                        onClick={() => openMetadataModal(file)}
                                                        className={`rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 border border-sky-500/30 font-medium transition-colors cursor-pointer ${
                                                            gridDensity === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5'
                                                        }`}
                                                    >
                                                        Meta
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            !fetchingFiles && (
                                <div className="text-center py-16 bg-slate-800/40 rounded-xl border border-dashed border-slate-700 text-slate-400 text-sm">
                                    Kattints a fenti „Fájlok beolvasása” gombra a médiafájlok megtekintéséhez!
                                </div>
                            )
                        )}
                    </div>
                )}
            </main>

            {/* Lebegő műveletsáv */}
            {selectedFileIds.length > 0 && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800/95 border border-sky-500/50 shadow-2xl backdrop-blur-md px-5 py-3 rounded-2xl flex items-center gap-4 z-40">
                    <div className="flex items-center gap-2 border-r border-slate-700 pr-4">
            <span className="w-6 h-6 rounded-full bg-sky-500 text-slate-950 font-bold text-xs flex items-center justify-center">
              {selectedFileIds.length}
            </span>
                        <span className="text-sm font-medium text-slate-200">kijelölve</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={openBulkModal}
                            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                        >
                            Tömeges címkézés
                        </button>
                        <button
                            onClick={() => handleBulkFavoriteToggle(true)}
                            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                        >
                            ★ Kedvenc
                        </button>
                        <button
                            onClick={() => handleBulkFavoriteToggle(false)}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                        >
                            ☆ Eltávolítás
                        </button>
                    </div>

                    <button
                        onClick={() => setSelectedFileIds([])}
                        className="text-slate-400 hover:text-white p-1 ml-2 transition-colors cursor-pointer"
                        title="Kijelölés törlése"
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Tömeges címkézés modál */}
            {isBulkModalOpen && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
                        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-slate-100">
                                    Tömeges címkehalmaz módosítás ({selectedFileIds.length} fájl)
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    Válassz ki címkéket hozzáadásra vagy elvételre anélkül, hogy felülírnád az egyéb adataikat.
                                </p>
                            </div>
                            <button
                                onClick={() => setIsBulkModalOpen(false)}
                                className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5 space-y-6 max-h-[70vh] overflow-y-auto">
                            <div>
                                <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                                    Új címke létrehozása a készletbe
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={bulkTagInput}
                                        onChange={(e) => setBulkTagInput(e.target.value)}
                                        onKeyDown={async (e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const tag = await registerNewTagToPool(bulkTagInput);
                                                if (tag) setBulkTagsToAdd((prev) => [...prev, tag]);
                                                setBulkTagInput('');
                                            }
                                        }}
                                        placeholder="Új címke neve..."
                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                                    />
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            const tag = await registerNewTagToPool(bulkTagInput);
                                            if (tag) setBulkTagsToAdd((prev) => [...prev, tag]);
                                            setBulkTagInput('');
                                        }}
                                        className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                                    >
                                        Felvétel
                                    </button>
                                </div>
                            </div>

                            <div>
                <span className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                  Elérhető címkék a poolból (Kattints a művelethez)
                </span>
                                <div className="flex flex-wrap gap-1.5 p-3 bg-slate-900/50 rounded-xl border border-slate-700/60 max-h-36 overflow-y-auto">
                                    {tagPool.length > 0 ? (
                                        tagPool.map((tag) => {
                                            const isAdding = bulkTagsToAdd.includes(tag);
                                            const isRemoving = bulkTagsToRemove.includes(tag);

                                            return (
                                                <div key={tag} className="inline-flex items-center rounded-md text-xs bg-slate-700 overflow-hidden">
                                                    <span className="px-2 py-1 text-slate-200">#{tag}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setBulkTagsToRemove((prev) => prev.filter((t) => t !== tag));
                                                            setBulkTagsToAdd((prev) =>
                                                                prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                                                            );
                                                        }}
                                                        className={`px-1.5 py-1 text-xs font-bold transition-colors cursor-pointer ${
                                                            isAdding ? 'bg-emerald-500 text-slate-950' : 'hover:bg-emerald-600 text-emerald-400'
                                                        }`}
                                                        title="Hozzáadás a fájlokhoz"
                                                    >
                                                        +
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setBulkTagsToAdd((prev) => prev.filter((t) => t !== tag));
                                                            setBulkTagsToRemove((prev) =>
                                                                prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                                                            );
                                                        }}
                                                        className={`px-1.5 py-1 text-xs font-bold transition-colors cursor-pointer ${
                                                            isRemoving ? 'bg-rose-500 text-white' : 'hover:bg-rose-600 text-rose-400'
                                                        }`}
                                                        title="Eltávolítás a fájlokból"
                                                    >
                                                        -
                                                    </button>
                                                </div>
                                            );
                                        })
                                    ) : (
                                        <span className="text-xs text-slate-500 italic p-1">
                      Még nincsenek címkék a készletben. Hozz létre egyet felül!
                    </span>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="p-3 bg-emerald-950/20 border border-emerald-500/30 rounded-xl">
                  <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider block mb-2">
                    [+] Hozzáadás ({bulkTagsToAdd.length})
                  </span>
                                    <div className="flex flex-wrap gap-1">
                                        {bulkTagsToAdd.map((tag) => (
                                            <span key={tag} className="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-300">
                        #{tag}
                      </span>
                                        ))}
                                        {bulkTagsToAdd.length === 0 && (
                                            <span className="text-xs text-slate-500 italic">Nincs kijelölve</span>
                                        )}
                                    </div>
                                </div>

                                <div className="p-3 bg-rose-950/20 border border-rose-500/30 rounded-xl">
                  <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider block mb-2">
                    [-] Törlés a halmazból ({bulkTagsToRemove.length})
                  </span>
                                    <div className="flex flex-wrap gap-1">
                                        {bulkTagsToRemove.map((tag) => (
                                            <span key={tag} className="px-2 py-0.5 rounded text-xs bg-rose-500/20 text-rose-300">
                        #{tag}
                      </span>
                                        ))}
                                        {bulkTagsToRemove.length === 0 && (
                                            <span className="text-xs text-slate-500 italic">Nincs kijelölve</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="p-4 border-t border-slate-700 bg-slate-850 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setIsBulkModalOpen(false)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                Mégse
                            </button>
                            <button
                                type="button"
                                disabled={bulkSaving || (bulkTagsToAdd.length === 0 && bulkTagsToRemove.length === 0)}
                                onClick={handleExecuteBulkTags}
                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                {bulkSaving ? 'Frissítés folyamatban...' : 'Műveletek végrehajtása'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Egyedi metaadat szerkesztő modál */}
            {activeFile && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
                        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-slate-100 truncate max-w-xs sm:max-w-md">
                                    {activeFile.name}
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">Egyéni metaadatok szerkesztése</p>
                            </div>
                            <button
                                onClick={() => setActiveFile(null)}
                                className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5 space-y-5">
                            {metaLoading ? (
                                <div className="text-center py-8 text-slate-400 text-sm">
                                    Adatok betöltése...
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between bg-slate-900/50 p-3 rounded-xl border border-slate-700/60">
                                        <span className="text-sm font-medium text-slate-200">Megjelölés kedvencként</span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setCurrentMeta((prev) => ({ ...prev, isFavorite: !prev.isFavorite }))
                                            }
                                            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                                                currentMeta.isFavorite
                                                    ? 'bg-amber-500 text-slate-950'
                                                    : 'bg-slate-700 text-slate-300'
                                            }`}
                                        >
                                            {currentMeta.isFavorite ? '★ Kedvenc' : '☆ Nem kedvenc'}
                                        </button>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                                            Címkék
                                        </label>
                                        <div className="flex gap-2 mb-3">
                                            <input
                                                type="text"
                                                value={tagInput}
                                                onChange={(e) => setTagInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleAddTagToCurrent(tagInput);
                                                    }
                                                }}
                                                placeholder="Címke hozzáadása..."
                                                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => handleAddTagToCurrent(tagInput)}
                                                className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                                            >
                                                Hozzáadás
                                            </button>
                                        </div>

                                        <div className="flex flex-wrap gap-1.5 min-h-8 p-2.5 bg-slate-900/40 rounded-xl border border-slate-700/50 mb-3">
                                            {currentMeta.tags.length > 0 ? (
                                                currentMeta.tags.map((tag) => (
                                                    <span
                                                        key={tag}
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-slate-700 text-sky-300"
                                                    >
                            #{tag}
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveTagFromCurrent(tag)}
                                                            className="text-slate-400 hover:text-rose-400 text-xs font-bold cursor-pointer"
                                                        >
                              ×
                            </button>
                          </span>
                                                ))
                                            ) : (
                                                <span className="text-xs text-slate-500 italic p-0.5">
                          Nincsenek címkék hozzárendelve.
                        </span>
                                            )}
                                        </div>

                                        {tagPool.length > 0 && (
                                            <div>
                        <span className="text-[11px] text-slate-400 block mb-1.5">
                          Válassz a meglévő címketárból:
                        </span>
                                                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                                                    {tagPool
                                                        .filter((t) => !currentMeta.tags.includes(t))
                                                        .map((tag) => (
                                                            <button
                                                                key={tag}
                                                                type="button"
                                                                onClick={() => handleAddTagToCurrent(tag)}
                                                                className="px-2 py-0.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                                                            >
                                                                + #{tag}
                                                            </button>
                                                        ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div>
                                        <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                                            Egyéni jegyzet
                                        </label>
                                        <textarea
                                            rows={3}
                                            value={currentMeta.note}
                                            onChange={(e) =>
                                                setCurrentMeta((prev) => ({ ...prev, note: e.target.value }))
                                            }
                                            placeholder="Írj egy rövid leírást..."
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:outline-none focus:border-sky-500 resize-none"
                                        />
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="p-4 border-t border-slate-700 bg-slate-850 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setActiveFile(null)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                Mégse
                            </button>
                            <button
                                type="button"
                                disabled={metaSaving || metaLoading}
                                onClick={handleSaveMetadata}
                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                {metaSaving ? 'Mentés...' : 'Mentés'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}