import { useState, useEffect, useCallback, type FormEvent } from 'react';
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
    serverTimestamp,
    collection,
    getDocs
} from 'firebase/firestore';

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    webViewLink?: string;
    size?: string;
    createdTime?: string;
    parents?: string[];
    shortcutDetails?: {
        targetId: string;
        targetMimeType: string;
    };
}

interface FolderNode {
    id: string;
    name: string;
    isOpen?: boolean;
    isLoading?: boolean;
    children?: FolderNode[];
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
type NavLayout = 'tree' | 'breadcrumb' | 'tags';

// URL Paraméterek azonosítása (User mód és Tulajdonos UID)
const urlParams = new URLSearchParams(window.location.search);
const paramRootId = urlParams.get('rootId');
const paramRootName = urlParams.get('rootName');
const paramOwnerId = urlParams.get('ownerId');
const isUserMode = Boolean(paramRootId);

const systemRootId = paramRootId || 'root';
const systemRootName = paramRootName ? decodeURIComponent(paramRootName) : 'Saját meghajtó';

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

function FolderTreeItem({
                            node,
                            selectedId,
                            onSelect,
                            onToggle,
                        }: {
    node: FolderNode;
    selectedId: string;
    onSelect: (folder: FolderNode) => void;
    onToggle: (folder: FolderNode) => void;
}) {
    const isSelected = selectedId === node.id;

    return (
        <div className="select-none">
            <div
                className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                    isSelected
                        ? 'bg-sky-500/20 text-sky-300 font-semibold border border-sky-500/40'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
            >
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggle(node);
                    }}
                    className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-slate-700/60"
                >
                    {node.isLoading ? (
                        <span className="animate-spin text-[10px]">⟳</span>
                    ) : (
                        <span className="text-[10px] transform transition-transform">
              {node.isOpen ? '▼' : '▶'}
            </span>
                    )}
                </button>

                <div
                    onClick={() => onSelect(node)}
                    className="flex items-center gap-2 flex-1 truncate"
                >
                    <span className="text-sm">📁</span>
                    <span className="truncate">{node.name}</span>
                </div>
            </div>

            {node.isOpen && node.children && (
                <div className="pl-4 ml-2 border-l border-slate-700/60 space-y-0.5 mt-0.5">
                    {node.children.map((child) => (
                        <FolderTreeItem
                            key={child.id}
                            node={child}
                            selectedId={selectedId}
                            onSelect={onSelect}
                            onToggle={onToggle}
                        />
                    ))}
                    {node.children.length === 0 && !node.isLoading && (
                        <div className="text-[11px] text-slate-500 italic py-1 pl-3">
                            (Nincs almappa)
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function App() {
    const [user, setUser] = useState<User | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(() => {
        return sessionStorage.getItem('drive_access_token');
    });
    const [loading, setLoading] = useState(true);

    // Navigációs mód
    const [navLayout, setNavLayout] = useState<NavLayout>('tags');

    // Mappa állapotok
    const [currentFolder, setCurrentFolder] = useState<BreadcrumbItem>({
        id: systemRootId,
        name: systemRootName,
    });
    const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
        { id: systemRootId, name: systemRootName },
    ]);

    // Fastruktúra (Sidebar)
    const [folderTree, setFolderTree] = useState<FolderNode>({
        id: systemRootId,
        name: systemRootName,
        isOpen: true,
        children: [],
    });

    // Almappák és rekurzió
    const [subfolders, setSubfolders] = useState<BreadcrumbItem[]>([]);
    const [fetchingFolders, setFetchingFolders] = useState(false);
    const [isRecursive, setIsRecursive] = useState(false);

    // Fájlok és szűrés
    const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
    const [fetchingFiles, setFetchingFiles] = useState(false);
    const [filterType, setFilterType] = useState<'all' | 'image' | 'video'>('all');
    const [gridDensity, setGridDensity] = useState<GridDensity>('md');

    // Címkék közvetlen megjelenítése a kártyán (kapcsoló állapota)
    const [showCardTags, setShowCardTags] = useState(false);

    // Kijelölési állapot
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

    // Globális Címketár és memóriabeli metaadatok
    const [tagPool, setTagPool] = useState<string[]>([]);
    const [selectedFilterTags, setSelectedFilterTags] = useState<string[]>([]);
    const [mediaMetaMap, setMediaMetaMap] = useState<Record<string, { tags: string[], isFavorite: boolean }>>({});

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

    // Tömeges módosítás
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [bulkTagsToAdd, setBulkTagsToAdd] = useState<string[]>([]);
    const [bulkTagsToRemove, setBulkTagsToRemove] = useState<string[]>([]);
    const [bulkTagInput, setBulkTagInput] = useState('');
    const [bulkSaving, setBulkSaving] = useState(false);

    // Mappa létrehozási ablak
    const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [creatingFolder, setCreatingFolder] = useState(false);

    // Mozgatás / Linkelés ablak
    const [transferModalMode, setTransferModalMode] = useState<'link' | 'move' | null>(null);
    const [targetFolderTree, setTargetFolderTree] = useState<FolderNode>({
        id: systemRootId,
        name: systemRootName,
        isOpen: true,
        children: [],
    });
    const [selectedTargetFolder, setSelectedTargetFolder] = useState<BreadcrumbItem>({
        id: systemRootId,
        name: systemRootName,
    });
    const [recentTargetFolders, setRecentTargetFolders] = useState<BreadcrumbItem[]>([]);
    const [executingTransfer, setExecutingTransfer] = useState(false);
    const [quickNewFolderInTransfer, setQuickNewFolderInTransfer] = useState('');
    const [creatingQuickFolder, setCreatingQuickFolder] = useState(false);

    // Megosztási link ablak (Admin)
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);

    const getEffectiveOwnerId = useCallback((currentUser?: User | null) => {
        return paramOwnerId || currentUser?.uid || user?.uid || '';
    }, [user]);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            if (!currentUser) {
                setAccessToken(null);
                sessionStorage.removeItem('drive_access_token');
                setDriveFiles([]);
                setSelectedFileIds([]);
                setActiveFile(null);
                setTagPool([]);
                setMediaMetaMap({});
            } else {
                const targetUid = getEffectiveOwnerId(currentUser);
                if (targetUid) {
                    void getDoc(doc(db, 'users', targetUid, 'settings', 'tagPool'))
                        .then((poolDoc) => {
                            if (poolDoc.exists()) {
                                setTagPool(poolDoc.data().tags || []);
                            }
                        })
                        .catch((err) => console.error('Címketár hiba:', err));

                    void getDocs(collection(db, 'users', targetUid, 'media'))
                        .then((metaSnap) => {
                            const metaMap: Record<string, { tags: string[], isFavorite: boolean }> = {};
                            metaSnap.forEach((docSnap) => {
                                metaMap[docSnap.id] = {
                                    tags: docSnap.data().tags || [],
                                    isFavorite: docSnap.data().isFavorite || false
                                };
                            });
                            setMediaMetaMap(metaMap);
                        })
                        .catch((err) => console.error('Kliensoldali metaadat hiba:', err));
                }
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, [getEffectiveOwnerId]);

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

    const fetchSubfoldersFromApi = useCallback(async (parentId: string, token: string): Promise<FolderNode[]> => {
        const params = new URLSearchParams({
            pageSize: '100',
            q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id,name)',
            orderBy: 'name',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
        });

        const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) return [];
        const data = await response.json();
        return (data.files || [])
            .filter((f: { id: string; name: string }) => !f.name.startsWith('.'))
            .map((f: { id: string; name: string }) => ({
                id: f.id,
                name: f.name,
                isOpen: false,
                children: undefined,
            }));
    }, []);

    const updateTreeNode = (
        root: FolderNode,
        targetId: string,
        updater: (node: FolderNode) => FolderNode
    ): FolderNode => {
        if (root.id === targetId) return updater(root);
        if (!root.children) return root;

        return {
            ...root,
            children: root.children.map((child) => updateTreeNode(child, targetId, updater)),
        };
    };

    const reloadFolderTree = useCallback(async () => {
        if (user && accessToken) {
            const subs = await fetchSubfoldersFromApi(systemRootId, accessToken);
            setFolderTree({ id: systemRootId, name: systemRootName, isOpen: true, children: subs });
        }
    }, [user, accessToken, fetchSubfoldersFromApi]);

    useEffect(() => {
        void reloadFolderTree();
    }, [reloadFolderTree]);

    const loadSubfoldersForBreadcrumb = useCallback(async (folderId: string) => {
        if (!accessToken) return;
        setFetchingFolders(true);
        try {
            const folders = await fetchSubfoldersFromApi(folderId, accessToken);
            setSubfolders(folders.map((f) => ({ id: f.id, name: f.name })));
        } finally {
            setFetchingFolders(false);
        }
    }, [accessToken, fetchSubfoldersFromApi]);

    useEffect(() => {
        if (user && accessToken && (navLayout === 'breadcrumb' || navLayout === 'tags')) {
            void loadSubfoldersForBreadcrumb(currentFolder.id);
        }
    }, [user, accessToken, currentFolder.id, navLayout, loadSubfoldersForBreadcrumb]);

    const handleToggleFolder = async (folder: FolderNode) => {
        if (folder.isOpen) {
            setFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isOpen: false }))
            );
            return;
        }

        if (folder.children === undefined && accessToken) {
            setFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isLoading: true }))
            );
            const children = await fetchSubfoldersFromApi(folder.id, accessToken);
            setFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({
                    ...node,
                    isOpen: true,
                    isLoading: false,
                    children,
                }))
            );
        } else {
            setFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isOpen: true }))
            );
        }
    };

    const handleToggleTargetFolder = async (folder: FolderNode) => {
        if (folder.isOpen) {
            setTargetFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isOpen: false }))
            );
            return;
        }

        if (folder.children === undefined && accessToken) {
            setTargetFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isLoading: true }))
            );
            const children = await fetchSubfoldersFromApi(folder.id, accessToken);
            setTargetFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({
                    ...node,
                    isOpen: true,
                    isLoading: false,
                    children,
                }))
            );
        } else {
            setTargetFolderTree((prev) =>
                updateTreeNode(prev, folder.id, (node) => ({ ...node, isOpen: true }))
            );
        }
    };

    const collectFolderIdsRecursively = useCallback(async (startFolderId: string): Promise<string[]> => {
        if (!accessToken) return [startFolderId];
        const allFolderIds: string[] = [startFolderId];
        const queue: string[] = [startFolderId];

        while (queue.length > 0) {
            const parentId = queue.shift()!;
            const params = new URLSearchParams({
                pageSize: '100',
                q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id,name)',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });

            try {
                const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                if (response.ok) {
                    const data = await response.json();
                    const childIds = (data.files || [])
                        .filter((f: { id: string; name: string }) => !f.name.startsWith('.'))
                        .map((f: { id: string }) => f.id);
                    allFolderIds.push(...childIds);
                    queue.push(...childIds);
                }
            } catch (e) {
                console.error('Rekurzív mappa hiba:', e);
            }
        }

        return allFolderIds;
    }, [accessToken]);

    const fetchAllDriveFilesByQuery = async (query: string, token: string): Promise<DriveFile[]> => {
        const results: DriveFile[] = [];
        let pageToken: string | undefined = undefined;

        do {
            const params = new URLSearchParams({
                pageSize: '1000',
                q: query,
                fields: 'nextPageToken, files(id,name,mimeType,thumbnailLink,webViewLink,size,createdTime,parents,shortcutDetails)',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });

            if (pageToken) {
                params.set('pageToken', pageToken);
            }

            const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!response.ok) {
                if (response.status === 401) {
                    alert('A token lejárt, kattints a Drive frissítése gombra!');
                    return results;
                }
                throw new Error(`Google API hiba: ${response.statusText}`);
            }

            const data = await response.json();
            if (data.files && data.files.length > 0) {
                results.push(...data.files);
            }
            pageToken = data.nextPageToken;
        } while (pageToken);

        return results;
    };

    const loadMediaFiles = useCallback(async (targetFolderId?: string) => {
        let currentToken = accessToken;
        if (!currentToken) {
            currentToken = await handleLoginOrRefreshToken();
            if (!currentToken) return;
        }

        const folderId = targetFolderId || currentFolder.id;
        setFetchingFiles(true);
        setSelectedFileIds([]);

        try {
            let typeFilter = "(mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.shortcut')";
            if (filterType === 'image') typeFilter = "(mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.shortcut')";
            if (filterType === 'video') typeFilter = "(mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.shortcut')";

            if (isRecursive) {
                const folderIds = await collectFolderIdsRecursively(folderId);
                const chunkSize = 15;
                const collectedFiles: DriveFile[] = [];

                for (let i = 0; i < folderIds.length; i += chunkSize) {
                    const chunk = folderIds.slice(i, i + chunkSize);
                    const parentQueries = chunk.map((id) => `'${id}' in parents`).join(' or ');
                    const q = `trashed = false and (${parentQueries}) and ${typeFilter}`;

                    const chunkFiles = await fetchAllDriveFilesByQuery(q, currentToken);
                    collectedFiles.push(...chunkFiles);
                }

                setDriveFiles(collectedFiles);
            } else {
                const q = `trashed = false and '${folderId}' in parents and ${typeFilter}`;
                const files = await fetchAllDriveFilesByQuery(q, currentToken);
                setDriveFiles(files);
            }
        } catch (err: unknown) {
            console.error('Fájl lekérési hiba:', err);
            const msg = err instanceof Error ? err.message : 'Ismeretlen hiba történt.';
            alert(msg);
        } finally {
            setFetchingFiles(false);
        }
    }, [accessToken, currentFolder.id, filterType, isRecursive, collectFolderIdsRecursively]);

    const handleSelectFolderFromTree = (folder: FolderNode) => {
        setCurrentFolder({ id: folder.id, name: folder.name });
        setBreadcrumbs([{ id: systemRootId, name: systemRootName }, { id: folder.id, name: folder.name }]);
        void loadMediaFiles(folder.id);
    };

    const handleEnterFolderBreadcrumb = (folder: BreadcrumbItem) => {
        setCurrentFolder(folder);
        setBreadcrumbs((prev) => [...prev, folder]);
        void loadMediaFiles(folder.id);
    };

    const handleJumpToBreadcrumb = (index: number) => {
        const target = breadcrumbs[index];
        setCurrentFolder(target);
        setBreadcrumbs((prev) => prev.slice(0, index + 1));
        void loadMediaFiles(target.id);
    };

    const handleCreateFolder = async (e: FormEvent) => {
        e.preventDefault();
        if (!newFolderName.trim() || !accessToken) return;

        setCreatingFolder(true);
        try {
            const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: newFolderName.trim(),
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [currentFolder.id],
                }),
            });

            if (!response.ok) {
                throw new Error('Nem sikerült létrehozni a mappát.');
            }

            setNewFolderName('');
            setIsCreateFolderModalOpen(false);
            await reloadFolderTree();
            await loadSubfoldersForBreadcrumb(currentFolder.id);
            alert('Mappa sikeresen létrehozva!');
        } catch (error) {
            console.error('Mappa létrehozási hiba:', error);
            alert('Hiba történt a mappa létrehozása közben.');
        } finally {
            setCreatingFolder(false);
        }
    };

    const openTransferModal = async (mode: 'link' | 'move') => {
        if (!accessToken) return;
        setTransferModalMode(mode);
        setQuickNewFolderInTransfer('');
        setSelectedTargetFolder({ id: currentFolder.id, name: currentFolder.name });

        try {
            const subs = await fetchSubfoldersFromApi(systemRootId, accessToken);
            setTargetFolderTree({
                id: systemRootId,
                name: systemRootName,
                isOpen: true,
                children: subs,
            });
        } catch (err) {
            console.error('Hiba a célmappafa inicializálásakor:', err);
        }
    };

    const handleCreateFolderInsideTransfer = async () => {
        if (!quickNewFolderInTransfer.trim() || !accessToken) return;

        setCreatingQuickFolder(true);
        try {
            const parentId = selectedTargetFolder.id;
            const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: quickNewFolderInTransfer.trim(),
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentId],
                }),
            });

            if (!response.ok) throw new Error('Nem sikerült létrehozni az új mappát.');
            const newFolder = await response.json();

            const createdNode: FolderNode = {
                id: newFolder.id,
                name: quickNewFolderInTransfer.trim(),
                isOpen: false,
                children: [],
            };

            setTargetFolderTree((prev) =>
                updateTreeNode(prev, parentId, (node) => ({
                    ...node,
                    isOpen: true,
                    children: node.children ? [...node.children, createdNode] : [createdNode],
                }))
            );

            setSelectedTargetFolder({ id: newFolder.id, name: quickNewFolderInTransfer.trim() });
            setQuickNewFolderInTransfer('');
            await reloadFolderTree();
        } catch (e) {
            console.error(e);
            alert('Nem sikerült létrehozni a célmappát.');
        } finally {
            setCreatingQuickFolder(false);
        }
    };

    const handleExecuteTransfer = async () => {
        if (!accessToken || selectedFileIds.length === 0 || !transferModalMode) return;
        setExecutingTransfer(true);

        const filesToProcess = driveFiles.filter((f) => selectedFileIds.includes(f.id));
        let successCount = 0;

        for (const file of filesToProcess) {
            try {
                if (transferModalMode === 'link') {
                    const targetId = file.shortcutDetails?.targetId || file.id;
                    const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            name: file.name,
                            mimeType: 'application/vnd.google-apps.shortcut',
                            parents: [selectedTargetFolder.id],
                            shortcutDetails: { targetId },
                        }),
                    });
                    if (res.ok) successCount++;
                } else if (transferModalMode === 'move') {
                    const oldParents = (file.parents || [currentFolder.id]).join(',');
                    const params = new URLSearchParams({
                        addParents: selectedTargetFolder.id,
                        removeParents: oldParents,
                        supportsAllDrives: 'true',
                    });
                    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?${params.toString()}`, {
                        method: 'PATCH',
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    if (res.ok) successCount++;
                }
            } catch (e) {
                console.error('Hiba a fájl feldolgozásakor:', file.name, e);
            }
        }

        setRecentTargetFolders((prev) => {
            const filtered = prev.filter((item) => item.id !== selectedTargetFolder.id);
            return [selectedTargetFolder, ...filtered].slice(0, 5);
        });

        setExecutingTransfer(false);
        setTransferModalMode(null);
        setSelectedFileIds([]);
        await loadMediaFiles(currentFolder.id);

        alert(
            transferModalMode === 'link'
                ? `Sikeresen létrehozva ${successCount} link a(z) "${selectedTargetFolder.name}" mappában!`
                : `Sikeresen átmozgatva ${successCount} fájl a(z) "${selectedTargetFolder.name}" mappába!`
        );
    };

    const getShareableUserUrl = () => {
        const base = window.location.origin + window.location.pathname;
        const ownerId = getEffectiveOwnerId();
        return `${base}?rootId=${encodeURIComponent(currentFolder.id)}&rootName=${encodeURIComponent(currentFolder.name)}&ownerId=${encodeURIComponent(ownerId)}`;
    };

    const handleCopyShareLink = async () => {
        try {
            await navigator.clipboard.writeText(getShareableUserUrl());
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2500);
        } catch (e) {
            console.error(e);
            alert('Nem sikerült vágólapra másolni a linket.');
        }
    };

    const displayedFiles = driveFiles.filter((file) => {
        if (navLayout !== 'tags' || selectedFilterTags.length === 0) return true;
        const fileTags = mediaMetaMap[file.id]?.tags || [];
        return selectedFilterTags.every((tag) => fileTags.includes(tag));
    });

    const toggleSelectFile = (id: string) => {
        setSelectedFileIds((prev) =>
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
        );
    };

    const handleSelectAll = () => {
        if (selectedFileIds.length === displayedFiles.length) {
            setSelectedFileIds([]);
        } else {
            setSelectedFileIds(displayedFiles.map((f) => f.id));
        }
    };

    const toggleFilterTag = (tag: string) => {
        setSelectedFilterTags((prev) =>
            prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
        );
    };

    const registerNewTagToPool = async (tag: string) => {
        const cleanTag = tag.trim().toLowerCase();
        const targetUid = getEffectiveOwnerId();
        if (!cleanTag || !targetUid) return cleanTag;

        if (!tagPool.includes(cleanTag)) {
            setTagPool((prev) => [...prev, cleanTag]);
            try {
                await setDoc(
                    doc(db, 'users', targetUid, 'settings', 'tagPool'),
                    { tags: arrayUnion(cleanTag) },
                    { merge: true }
                );
            } catch (err) {
                console.error('Címke mentési hiba:', err);
            }
        }
        return cleanTag;
    };

    const openMetadataModal = async (file: DriveFile) => {
        setActiveFile(file);
        setMetaLoading(true);
        setTagInput('');

        const targetUid = getEffectiveOwnerId();
        if (!targetUid) return;

        try {
            const docRef = doc(db, 'users', targetUid, 'media', file.id);
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
            console.error('Metaadat betöltési hiba:', error);
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
        const targetUid = getEffectiveOwnerId();
        if (!targetUid || !activeFile) return;

        setMetaSaving(true);
        try {
            const docRef = doc(db, 'users', targetUid, 'media', activeFile.id);
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

            setMediaMetaMap((prev) => ({
                ...prev,
                [activeFile.id]: {
                    tags: currentMeta.tags,
                    isFavorite: currentMeta.isFavorite
                }
            }));

            setActiveFile(null);
        } catch (error) {
            console.error('Mentési hiba:', error);
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
        const targetUid = getEffectiveOwnerId();
        if (!targetUid || selectedFileIds.length === 0) return;
        if (bulkTagsToAdd.length === 0 && bulkTagsToRemove.length === 0) {
            alert('Nincs kiválasztva sem hozzáadandó, sem eltávolítandó címke.');
            return;
        }

        setBulkSaving(true);
        try {
            const batch = writeBatch(db);

            selectedFileIds.forEach((fileId) => {
                const fileRef = doc(db, 'users', targetUid, 'media', fileId);
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

            setMediaMetaMap((prev) => {
                const newMap = { ...prev };
                selectedFileIds.forEach((id) => {
                    const existingTags = newMap[id]?.tags || [];
                    let newTags = [...existingTags];

                    if (bulkTagsToAdd.length > 0) {
                        newTags = Array.from(new Set([...newTags, ...bulkTagsToAdd]));
                    }
                    if (bulkTagsToRemove.length > 0) {
                        newTags = newTags.filter((t) => !bulkTagsToRemove.includes(t));
                    }
                    newMap[id] = {
                        tags: newTags,
                        isFavorite: newMap[id]?.isFavorite || false
                    };
                });
                return newMap;
            });

            setIsBulkModalOpen(false);
            setSelectedFileIds([]);
            alert(`Sikeresen frissítve ${selectedFileIds.length} fájl címkéje!`);
        } catch (error) {
            console.error('Tömeges hiba:', error);
            alert('Hiba történt a tömeges címkézés során.');
        } finally {
            setBulkSaving(false);
        }
    };

    const handleBulkFavoriteToggle = async (markAsFavorite: boolean) => {
        const targetUid = getEffectiveOwnerId();
        if (!targetUid || selectedFileIds.length === 0) return;

        try {
            const batch = writeBatch(db);
            selectedFileIds.forEach((fileId) => {
                const fileRef = doc(db, 'users', targetUid, 'media', fileId);
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

            setMediaMetaMap((prev) => {
                const newMap = { ...prev };
                selectedFileIds.forEach((id) => {
                    newMap[id] = {
                        tags: newMap[id]?.tags || [],
                        isFavorite: markAsFavorite
                    };
                });
                return newMap;
            });

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

    const gridClasses = {
        sm: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3',
        md: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4',
        lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6',
    }[gridDensity];

    if (loading) {
        return (
            <div className="h-screen bg-slate-900 text-white flex items-center justify-center">
                <p className="text-slate-400">Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="h-screen bg-slate-900 text-white flex flex-col overflow-hidden">
            {/* Rögzített Fejléc */}
            <header className="px-6 py-3.5 border-b border-slate-800 bg-slate-900 shrink-0 z-30 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-sky-500 rounded-lg flex items-center justify-center font-bold text-slate-950 text-sm">
                        M
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-sky-400 flex items-center gap-2">
                            <span>Media Manager</span>
                            {isUserMode ? (
                                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  User nézet
                </span>
                            ) : (
                                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  Admin mód
                </span>
                            )}
                        </h1>
                    </div>
                </div>

                {user ? (
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2.5">
                            {user.photoURL && (
                                <img
                                    src={user.photoURL}
                                    alt={user.displayName || 'Profilkép'}
                                    referrerPolicy="no-referrer"
                                    className="w-8 h-8 rounded-full border border-sky-400 object-cover"
                                />
                            )}
                            <span className="text-sm font-medium text-slate-300 hidden sm:inline">
                {user.displayName}
              </span>
                        </div>

                        {!isUserMode && (
                            <button
                                onClick={() => setIsShareModalOpen(true)}
                                className="px-3 py-1.5 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                                title="User link készítése az aktuális mappához"
                            >
                                <span>🔗</span> User link generálása
                            </button>
                        )}

                        <button
                            onClick={() => { void handleLoginOrRefreshToken(); }}
                            className="px-3 py-1.5 bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 border border-sky-500/40 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            🔄 Drive frissítése
                        </button>

                        <button
                            onClick={() => { void handleLogout(); }}
                            className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            Kijelentkezés
                        </button>
                    </div>
                ) : null}
            </header>

            {/* Fő tartalom */}
            {!user ? (
                <main className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
                    <div className="text-center py-20 px-8 bg-slate-800 rounded-2xl border border-slate-700 max-w-md w-full shadow-xl">
                        <h2 className="text-xl font-semibold mb-2">Üdvözöl a Media Manager!</h2>
                        <p className="text-slate-400 mb-6 text-sm">
                            Jelentkezz be Google-fiókoddal a megosztott mappa kezeléséhez.
                        </p>
                        <button
                            onClick={() => { void handleLoginOrRefreshToken(); }}
                            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 font-semibold rounded-lg transition-colors cursor-pointer"
                        >
                            Bejelentkezés Google-fiókkal
                        </button>
                    </div>
                </main>
            ) : (
                <div className="flex-1 flex overflow-hidden min-h-0">

                    {/* BAL OLDALI SÁV (Mappafa VAGY Címkék) */}
                    {(navLayout === 'tree' || navLayout === 'tags') && (
                        <aside className="w-64 md:w-72 lg:w-80 border-r border-slate-800 bg-slate-850/50 flex flex-col p-4 overflow-y-auto shrink-0 h-full">
                            {navLayout === 'tree' ? (
                                <>
                                    <div className="flex items-center justify-between mb-3 px-2 shrink-0">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {isUserMode ? `Mappák (${systemRootName})` : 'Mappák (Google Drive)'}
                    </span>
                                        <button
                                            onClick={() => { void reloadFolderTree(); }}
                                            className="text-[11px] text-sky-400 hover:text-sky-300 font-medium cursor-pointer"
                                        >
                                            Frissítés
                                        </button>
                                    </div>
                                    <div className="space-y-1">
                                        <FolderTreeItem
                                            node={folderTree}
                                            selectedId={currentFolder.id}
                                            onSelect={handleSelectFolderFromTree}
                                            onToggle={(f) => { void handleToggleFolder(f); }}
                                        />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between mb-4 px-2 shrink-0">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      Címkék szerinti szűrés
                    </span>
                                        {selectedFilterTags.length > 0 && (
                                            <button
                                                onClick={() => setSelectedFilterTags([])}
                                                className="text-[11px] text-rose-400 hover:text-rose-300 font-medium cursor-pointer"
                                            >
                                                Törlés
                                            </button>
                                        )}
                                    </div>

                                    <div className="space-y-2 px-2">
                                        {tagPool.length === 0 ? (
                                            <div className="text-xs text-slate-500 italic">Még nincsenek címkék a megosztásban.</div>
                                        ) : (
                                            tagPool.map((tag) => (
                                                <label key={tag} className="flex items-center gap-2.5 text-sm text-slate-300 hover:text-white cursor-pointer group">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedFilterTags.includes(tag)}
                                                        onChange={() => toggleFilterTag(tag)}
                                                        className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
                                                    />
                                                    <span className={`truncate transition-colors ${selectedFilterTags.includes(tag) ? 'text-sky-300 font-medium' : 'group-hover:text-sky-100'}`}>
                            #{tag}
                          </span>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                </>
                            )}
                        </aside>
                    )}

                    {/* JOBB OLDALI TARTALOM */}
                    <main className="flex-1 flex flex-col overflow-y-auto p-6 pb-28 h-full min-h-0">
                        {/* Vezérlősáv */}
                        <div className="bg-slate-800/80 backdrop-blur p-4 rounded-xl border border-slate-700 space-y-4 mb-6 shrink-0">
                            <div className="flex flex-wrap items-center justify-between gap-4">

                                {/* 1. MÓDSZERVÁLASZTÓ */}
                                <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-700">
                                    <button
                                        onClick={() => setNavLayout('tree')}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            navLayout === 'tree' ? 'bg-sky-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        <span>🌲</span> Mappák
                                    </button>
                                    <button
                                        onClick={() => setNavLayout('breadcrumb')}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            navLayout === 'breadcrumb' ? 'bg-sky-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        <span>📍</span> Útvonal
                                    </button>
                                    <button
                                        onClick={() => setNavLayout('tags')}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            navLayout === 'tags' ? 'bg-sky-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        <span>🏷️</span> Címkék
                                    </button>
                                </div>

                                {/* Új mappa + Szűrők, Kártyacímke kapcsoló, Rácsméret és Beolvasás */}
                                <div className="flex flex-wrap items-center gap-3">
                                    <button
                                        onClick={() => setIsCreateFolderModalOpen(true)}
                                        className="px-3 py-1.5 bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                                        title="Új mappa létrehozása az aktuális mappában"
                                    >
                                        <span>📁+</span> Új mappa
                                    </button>

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

                                    {/* CÍMKÉK MEGJELENÍTÉSE A KÁRTYÁN KAPCSOLÓ */}
                                    <button
                                        type="button"
                                        onClick={() => setShowCardTags((prev) => !prev)}
                                        className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                                            showCardTags
                                                ? 'bg-sky-500 text-slate-950 font-bold shadow-md'
                                                : 'bg-slate-900/60 text-slate-400 hover:text-white border border-slate-700'
                                        }`}
                                        title="Címkék mutatása vagy elrejtése közvetlenül a kártyákon"
                                    >
                                        <span>🏷️</span>
                                        <span>Címkék: {showCardTags ? 'BE' : 'KI'}</span>
                                    </button>

                                    <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-lg border border-slate-700">
                                        <button
                                            onClick={() => setGridDensity('sm')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'sm' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Kicsi
                                        </button>
                                        <button
                                            onClick={() => setGridDensity('md')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'md' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Közép
                                        </button>
                                        <button
                                            onClick={() => setGridDensity('lg')}
                                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                                                gridDensity === 'lg' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            Nagy
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => { void loadMediaFiles(); }}
                                        disabled={fetchingFiles}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 font-medium rounded-lg transition-colors cursor-pointer text-xs flex items-center gap-2"
                                    >
                                        {fetchingFiles ? 'Betöltés...' : 'Fájlok beolvasása'}
                                    </button>
                                </div>
                            </div>

                            {/* BREADCRUMB ÉS TAGS MÓD VEZÉRLŐI */}
                            {(navLayout === 'breadcrumb' || navLayout === 'tags') && (
                                <div className="pt-3 border-t border-slate-700/60 space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/40 p-2.5 rounded-lg border border-slate-700/50">
                                        <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-300">
                        📁 Mappa: <strong className="text-sky-300">{currentFolder.name}</strong>
                      </span>
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

                                    <div className="flex items-center gap-1.5 text-xs bg-slate-900/30 p-2 rounded-lg border border-slate-700/40 flex-wrap">
                                        <span className="text-slate-500 font-semibold uppercase mr-1">Útvonal:</span>
                                        {breadcrumbs.map((crumb, idx) => (
                                            <div key={crumb.id} className="flex items-center gap-1.5">
                                                {idx > 0 && <span className="text-slate-600">/</span>}
                                                <button
                                                    onClick={() => handleJumpToBreadcrumb(idx)}
                                                    className={`px-2 py-0.5 rounded text-xs transition-colors cursor-pointer ${
                                                        idx === breadcrumbs.length - 1 ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                                    }`}
                                                >
                                                    {crumb.name}
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    <div>
                                        {fetchingFolders && (
                                            <div className="text-xs text-sky-400 mb-1">Mappák keresése folyamatban...</div>
                                        )}
                                        <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto p-1">
                                            {subfolders.map((folder) => (
                                                <button
                                                    key={folder.id}
                                                    onClick={() => handleEnterFolderBreadcrumb(folder)}
                                                    className="px-3 py-1.5 rounded-lg bg-slate-700/70 hover:bg-slate-700 text-slate-200 border border-slate-600 text-xs flex items-center gap-1.5 transition-all cursor-pointer group"
                                                >
                                                    <span>📂</span>
                                                    <span className="truncate max-w-[150px]">{folder.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* TREE MÓD AKTUÁLIS MAPPA KIJELZÉSE */}
                            {navLayout === 'tree' && (
                                <div className="pt-2 border-t border-slate-700/60 flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-sm">
                                        <span className="text-slate-400 text-xs uppercase font-semibold">Aktuális mappa:</span>
                                        <span className="font-bold text-sky-300 flex items-center gap-1.5">
                      <span>📁</span> {currentFolder.name}
                    </span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Számláló és gyors kijelölés */}
                        {displayedFiles.length > 0 ? (
                            <div className="flex items-center justify-between mb-4 px-1 shrink-0">
                <span className="text-xs text-slate-400">
                  Megjelenített médiafájlok: <strong className="text-slate-200">{displayedFiles.length}</strong>
                    {navLayout === 'tags' && selectedFilterTags.length > 0 && (
                        <span className="ml-2 text-sky-400">({driveFiles.length} beolvasott fájlból szűrve)</span>
                    )}
                </span>

                                <button
                                    onClick={handleSelectAll}
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                                >
                                    {selectedFileIds.length === displayedFiles.length ? 'Kijelölés törlése' : 'Összes kijelölése'}
                                </button>
                            </div>
                        ) : (
                            !fetchingFiles && driveFiles.length > 0 && navLayout === 'tags' && selectedFilterTags.length > 0 && (
                                <div className="text-center py-8 text-slate-400 text-sm">
                                    Ebben a mappában nincsenek olyan képek, amelyeken mind a kiválasztott <strong>{selectedFilterTags.length}</strong> címke szerepel.
                                </div>
                            )
                        )}

                        {/* Médiagaléria rács */}
                        {displayedFiles.length > 0 ? (
                            <div className={`grid ${gridClasses}`}>
                                {displayedFiles.map((file) => {
                                    const isShortcut = file.mimeType === 'application/vnd.google-apps.shortcut';
                                    const isVideo = file.mimeType.startsWith('video/') || file.shortcutDetails?.targetMimeType?.startsWith('video/');
                                    const isSelected = selectedFileIds.includes(file.id);
                                    const previewSrc = file.thumbnailLink
                                        ? file.thumbnailLink.replace(/=s\d+/, gridDensity === 'lg' ? '=s800' : '=s400')
                                        : undefined;

                                    const fileMeta = mediaMetaMap[file.id];
                                    const fileTags = fileMeta?.tags || [];

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

                                                <div className="absolute top-2 right-2 flex items-center gap-1">
                                                    {isShortcut && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase bg-amber-500/90 text-slate-950">
                              🔗 Link
                            </span>
                                                    )}
                                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-300">
                            {isVideo ? 'Videó' : 'Kép'}
                          </span>
                                                </div>
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

                                                    {/* Címkék megjelenítése a kártyán, ha a kapcsoló be van kapcsolva */}
                                                    {showCardTags && fileTags.length > 0 && (
                                                        <div className="flex flex-wrap gap-1 mt-2.5 max-h-16 overflow-y-auto">
                                                            {fileTags.map((tag) => (
                                                                <span
                                                                    key={tag}
                                                                    className="px-1.5 py-0.5 rounded text-[10px] bg-slate-700/80 text-sky-300 border border-slate-600/50 truncate max-w-[120px]"
                                                                    title={`#${tag}`}
                                                                >
                                  #{tag}
                                </span>
                                                            ))}
                                                        </div>
                                                    )}
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
                                                        onClick={() => { void openMetadataModal(file); }}
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
                            !fetchingFiles && driveFiles.length === 0 && (
                                <div className="text-center py-20 bg-slate-800/40 rounded-xl border border-dashed border-slate-700 text-slate-400 text-sm">
                                    Kattints a „Fájlok beolvasása” gombra a médiafájlok megtekintéséhez!
                                </div>
                            )
                        )}
                    </main>
                </div>
            )}

            {/* Lebegő műveletsáv */}
            {selectedFileIds.length > 0 && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800/95 border border-sky-500/50 shadow-2xl backdrop-blur-md px-5 py-3 rounded-2xl flex items-center gap-3 z-40 max-w-[95vw] overflow-x-auto">
                    <div className="flex items-center gap-2 border-r border-slate-700 pr-3 shrink-0">
            <span className="w-6 h-6 rounded-full bg-sky-500 text-slate-950 font-bold text-xs flex items-center justify-center">
              {selectedFileIds.length}
            </span>
                        <span className="text-sm font-medium text-slate-200 hidden sm:inline">kijelölve</span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={openBulkModal}
                            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                        >
                            Címkézés
                        </button>
                        <button
                            onClick={() => { void openTransferModal('link'); }}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
                            title="Parancsikonok készítése a kijelölt mappában"
                        >
                            <span>🔗</span> Linkelés mappába
                        </button>
                        <button
                            onClick={() => { void openTransferModal('move'); }}
                            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
                            title="Fájlok áthelyezése"
                        >
                            <span>📦</span> Mozgatás
                        </button>
                        <button
                            onClick={() => { void handleBulkFavoriteToggle(true); }}
                            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                        >
                            ★ Kedvenc
                        </button>
                    </div>

                    <button
                        onClick={() => setSelectedFileIds([])}
                        className="text-slate-400 hover:text-white p-1 ml-1 transition-colors cursor-pointer shrink-0"
                        title="Kijelölés törlése"
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* ADMIN: USER LINK GENERÁLÓ MODÁL */}
            {isShareModalOpen && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
                        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
                                <span>🔗</span> User link generálása
                            </h3>
                            <button
                                type="button"
                                onClick={() => setIsShareModalOpen(false)}
                                className="text-slate-400 hover:text-white p-1 rounded-lg"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <p className="text-xs text-slate-300 leading-relaxed">
                                Ez a link egy korlátozott felületet indít el, amellyel a felhasználó kizárólag a kiválasztott mappa alatt böngészhet, és <strong>nem tud felfelé navigálni</strong>:
                            </p>

                            <div className="p-3 bg-slate-900/80 border border-slate-700 rounded-xl space-y-1">
                                <span className="text-[10px] uppercase font-semibold text-slate-500 block">Kijelölt gyökérmappa:</span>
                                <span className="text-sm font-bold text-sky-400 flex items-center gap-1.5">
                  📁 {currentFolder.name}
                </span>
                            </div>

                            <div>
                                <label className="block text-[11px] font-semibold text-slate-400 mb-1 uppercase tracking-wider">
                                    Megosztható URL (tartalmazza a címketár azonosítót is)
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={getShareableUserUrl()}
                                        className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 font-mono select-all focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => { void handleCopyShareLink(); }}
                                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shrink-0"
                                    >
                                        {linkCopied ? '✓ Másolva!' : 'Másolás'}
                                    </button>
                                </div>
                            </div>

                            <div className="p-3 bg-emerald-950/20 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 leading-relaxed">
                                💡 A felhasználó látni fogja a fotókhoz tartozó címkéket és szűrhet is rájuk!
                            </div>
                        </div>

                        <div className="p-4 border-t border-slate-700 bg-slate-850 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setIsShareModalOpen(false)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                            >
                                Bezárás
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ÚJ MAPPA MODÁL */}
            {isCreateFolderModalOpen && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <form
                        onSubmit={(e) => { void handleCreateFolder(e); }}
                        className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col"
                    >
                        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
                                <span>📁</span> Új mappa létrehozása
                            </h3>
                            <button
                                type="button"
                                onClick={() => setIsCreateFolderModalOpen(false)}
                                className="text-slate-400 hover:text-white p-1 rounded-lg"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <p className="text-xs text-slate-400">
                                A mappa itt fog létrejönni: <strong className="text-sky-300">{currentFolder.name}</strong>
                            </p>
                            <div>
                                <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
                                    Mappa neve
                                </label>
                                <input
                                    type="text"
                                    required
                                    autoFocus
                                    value={newFolderName}
                                    onChange={(e) => setNewFolderName(e.target.value)}
                                    placeholder="Pl. 2026_Nyaralas_Valogatott..."
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                                />
                            </div>
                        </div>

                        <div className="p-4 border-t border-slate-700 bg-slate-850 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setIsCreateFolderModalOpen(false)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                Mégse
                            </button>
                            <button
                                type="submit"
                                disabled={creatingFolder || !newFolderName.trim()}
                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                {creatingFolder ? 'Létrehozás...' : 'Mappa létrehozása'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* ÁTLINKELÉS / MOZGATÁS MODÁL (INTERAKTÍV MAPPAFÁVAL) */}
            {transferModalMode && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col">
                        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-slate-100 flex items-center gap-2">
                                    <span>{transferModalMode === 'link' ? '🔗' : '📦'}</span>
                                    <span>
                    {transferModalMode === 'link' ? 'Linkelés (Shortcut) mappába' : 'Fájlok mozgatása'}
                  </span>
                                </h3>
                                <p className="text-xs text-slate-400 mt-1">
                                    Kiválasztott célmappa:{' '}
                                    <strong className="text-sky-300 font-semibold">📁 {selectedTargetFolder.name}</strong>
                                </p>
                            </div>
                            <button
                                onClick={() => setTransferModalMode(null)}
                                className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="md:col-span-1 space-y-3 border-b md:border-b-0 md:border-r border-slate-700/60 pb-3 md:pb-0 md:pr-3">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Gyors választó
                  </span>

                                    <div className="space-y-1.5">
                                        <button
                                            type="button"
                                            onClick={() => setSelectedTargetFolder({ id: currentFolder.id, name: currentFolder.name })}
                                            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
                                                selectedTargetFolder.id === currentFolder.id
                                                    ? 'bg-sky-500/20 text-sky-300 font-semibold border border-sky-500/40'
                                                    : 'bg-slate-900/40 hover:bg-slate-700/60 text-slate-300'
                                            }`}
                                        >
                                            <span>📍</span>
                                            <span className="truncate">Aktuális ({currentFolder.name})</span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => setSelectedTargetFolder({ id: systemRootId, name: systemRootName })}
                                            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
                                                selectedTargetFolder.id === systemRootId
                                                    ? 'bg-sky-500/20 text-sky-300 font-semibold border border-sky-500/40'
                                                    : 'bg-slate-900/40 hover:bg-slate-700/60 text-slate-300'
                                            }`}
                                        >
                                            <span>📁</span>
                                            <span className="truncate">Gyökérkönyvtár</span>
                                        </button>
                                    </div>

                                    {recentTargetFolders.length > 0 && (
                                        <div className="pt-2">
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
                        Legutóbbi célok
                      </span>
                                            <div className="space-y-1 max-h-32 overflow-y-auto">
                                                {recentTargetFolders.map((rf) => (
                                                    <button
                                                        key={rf.id}
                                                        type="button"
                                                        onClick={() => setSelectedTargetFolder(rf)}
                                                        className={`w-full text-left px-2 py-1 rounded text-xs transition-colors flex items-center gap-1.5 truncate cursor-pointer ${
                                                            selectedTargetFolder.id === rf.id
                                                                ? 'bg-sky-500/20 text-sky-300 font-medium'
                                                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                                                        }`}
                                                    >
                                                        <span>📂</span>
                                                        <span className="truncate">{rf.name}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="md:col-span-2 flex flex-col min-h-0">
                                    <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                      Tallózás a mappafában
                    </span>
                                        <span className="text-[10px] text-slate-500">Nyisd le az ágakat a nyilakkal</span>
                                    </div>

                                    <div className="bg-slate-900/80 border border-slate-700/70 rounded-xl p-2.5 h-56 overflow-y-auto space-y-1">
                                        <FolderTreeItem
                                            node={targetFolderTree}
                                            selectedId={selectedTargetFolder.id}
                                            onSelect={(f) => setSelectedTargetFolder({ id: f.id, name: f.name })}
                                            onToggle={(f) => { void handleToggleTargetFolder(f); }}
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="pt-3 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-3 bg-slate-900/30 p-2.5 rounded-xl border border-slate-700/40">
                <span className="text-xs text-slate-300">
                  Új almappa a(z) <strong>{selectedTargetFolder.name}</strong> mappán belül:
                </span>
                                <div className="flex gap-2 flex-1 max-w-xs">
                                    <input
                                        type="text"
                                        value={quickNewFolderInTransfer}
                                        onChange={(e) => setQuickNewFolderInTransfer(e.target.value)}
                                        placeholder="Új almappa neve..."
                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                                    />
                                    <button
                                        type="button"
                                        disabled={creatingQuickFolder || !quickNewFolderInTransfer.trim()}
                                        onClick={() => { void handleCreateFolderInsideTransfer(); }}
                                        className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                                    >
                                        {creatingQuickFolder ? '...' : '+ Létrehozás'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="p-4 border-t border-slate-700 bg-slate-850 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setTransferModalMode(null)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                Mégse
                            </button>
                            <button
                                type="button"
                                disabled={executingTransfer}
                                onClick={() => { void handleExecuteTransfer(); }}
                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                            >
                                {executingTransfer ? 'Végrehajtás...' : 'Végrehajtás ide'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* EGYEDI METAADAT SZERKESZTŐ MODÁL */}
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
                                                        void handleAddTagToCurrent(tagInput);
                                                    }
                                                }}
                                                placeholder="Címke hozzáadása..."
                                                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => { void handleAddTagToCurrent(tagInput); }}
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
                                                                onClick={() => { void handleAddTagToCurrent(tag); }}
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
                                onClick={() => { void handleSaveMetadata(); }}
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