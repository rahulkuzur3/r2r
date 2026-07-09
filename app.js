import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithPopup, 
    GoogleAuthProvider, 
    onAuthStateChanged, 
    signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    setDoc, 
    updateDoc, 
    getDoc, 
    collection, 
    addDoc, 
    query, 
    where, 
    orderBy, 
    onSnapshot, 
    limit, 
    serverTimestamp, 
    arrayUnion, 
    arrayRemove, 
    deleteDoc,
    increment,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    getMessaging, 
    getToken, 
    onMessage 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// =========================================================================
// CENTRAL APP CONFIGURATION MODULE
// =========================================================================
const CONFIG = {
    brand: {
        logoUrl: "https://kuzur.uk/images/profile.webp", // Optional Custom brand logo URL
        name: " You & ME "
    },
    firebase: {
        apiKey: "AIzaSyAzknhpykWqOMQ6PiYBOrrAhJJe4pjBHT0",
        authDomain: "chatapp-41c42.firebaseapp.com",
        projectId: "chatapp-41c42",
        storageBucket: "chatapp-41c42.firebasestorage.app",
        messagingSenderId: "951419000735",
        appId: "1:951419000735:web:372285c54ce38e57b5cfaa",
        measurementId: "G-39TE9J4CRV"
    },
    cloudflareR2: {
        workerUploadUrl: "https://upload.kuzur.uk", 
        publicUrlDomain: "https://r2.kuzur.uk",
        uploadSecretToken: "", 
        bucketName: "YOUR_R2_BUCKET_NAME", 
        accountId: "YOUR_CLOUDFLARE_ACCOUNT_ID", 
        accessKeyId: "YOUR_R2_ACCESS_KEY_ID", 
        secretAccessKey: "YOUR_R2_SECRET_ACCESS_KEY" 
    },
    zegocloud: {
        appID: 1961210239,
        serverSecret: "f6ea154871eb87a453b0f0c610a381ed"
    },
    onesignal: {
        appId: "YOUR_ONESIGNAL_APP_ID" // Replace with actual OneSignal App ID
    }
};

// =========================================================================
// APPLICATION ORCHESTRATOR
// =========================================================================
class NexusChatApp {
    constructor() {
        this.firebaseApp = initializeApp(CONFIG.firebase);
        this.auth = getAuth(this.firebaseApp);
        this.db = getFirestore(this.firebaseApp);
        this.s3Client = null;
        this.zegoInstance = null;
        
        // System state variables
        this.currentUser = null;
        this.activeChatId = null;
        this.activeChatType = null; // 'private' or 'group'
        this.activeTargetUser = null;
        this.activeGroupData = null;
        
        this.activeMessagesListener = null;
        this.presenceInterval = null;
        this.voiceRecorder = null;
        this.voiceChunks = [];
        this.activeReplyMessage = null;
        
        this.activeCallSessionId = null;

        this.initS3Client();
        this.initOneSignal();
        this.loadBrandCustomizations();
        this.bindDOMEvents();
    }

    initS3Client() {
        if (CONFIG.cloudflareR2.accountId && CONFIG.cloudflareR2.accessKeyId) {
            AWS.config.update({
                accessKeyId: CONFIG.cloudflareR2.accessKeyId,
                secretAccessKey: CONFIG.cloudflareR2.secretAccessKey,
                region: 'auto'
            });
            this.s3Client = new AWS.S3({
                endpoint: `https://${CONFIG.cloudflareR2.accountId}.r2.cloudflarestorage.com`,
                signatureVersion: 'v4'
            });
        }
    }

    initOneSignal() {
        if (!CONFIG.onesignal.appId || CONFIG.onesignal.appId === "YOUR_ONESIGNAL_APP_ID") return;
        
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        OneSignalDeferred.push(async (OneSignal) => {
            try {
                await OneSignal.init({
                    appId: CONFIG.onesignal.appId,
                    allowLocalhostAsSecureOrigin: true 
                });
                if (OneSignal.Notifications.permission === "default") {
                    await OneSignal.Notifications.requestPermission();
                }
            } catch (err) {
                console.warn("OneSignal initialized with restrictions:", err);
            }
        });
    }

    loadBrandCustomizations() {
        if (!CONFIG.brand) return;
        const logoContainer = document.getElementById('login-logo-container');
        const loginTitle = document.getElementById('login-brand-title');

        if (CONFIG.brand.logoUrl && CONFIG.brand.logoUrl.trim() !== "") {
            logoContainer.innerHTML = `<img src="${CONFIG.brand.logoUrl}" class="w-full h-full object-contain p-1.5" alt="Logo">`;
            logoContainer.classList.remove('text-brand-500'); 
        }
        if (CONFIG.brand.name && CONFIG.brand.name.trim() !== "") {
            loginTitle.textContent = CONFIG.brand.name;
        }
    }

    ensureAbsoluteUrl(url) {
        if (!url) return "";
        const cleanUrl = url.trim();
        if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
            return cleanUrl;
        }
        if (cleanUrl.includes('.') && !cleanUrl.startsWith('/')) {
            return `https://${cleanUrl}`;
        }
        return cleanUrl;
    }

    bindDOMEvents() {
        // Authenticator Controls
        document.getElementById('btn-login').addEventListener('click', () => this.signInGoogle());
        document.getElementById('btn-logout').addEventListener('click', () => this.signOutUser());

        // Navigation Tabs Selection
        document.getElementById('tab-chats').addEventListener('click', (e) => this.switchSidebarTab(e, 'chats'));
        document.getElementById('tab-groups').addEventListener('click', (e) => this.switchSidebarTab(e, 'groups'));
        document.getElementById('tab-users').addEventListener('click', (e) => this.switchSidebarTab(e, 'users'));
        document.getElementById('sidebar-search').addEventListener('input', (e) => this.handleSearch(e.target.value));

        // Mobile Layout Back Toggle
        document.getElementById('btn-back-to-sidebar').addEventListener('click', () => this.exitActiveChatMobile());

        // Media Dropdown Attachments toggler
        document.getElementById('btn-attachment-toggle').addEventListener('click', () => {
            this.toggleElementDisplay('attachment-menu');
        });
        document.getElementById('btn-attach-image').addEventListener('click', () => {
            document.getElementById('input-image-upload').click();
            this.toggleElementDisplay('attachment-menu', false);
        });
        document.getElementById('btn-attach-file').addEventListener('click', () => {
            document.getElementById('input-file-upload').click();
            this.toggleElementDisplay('attachment-menu', false);
        });

        // Input uploads selectors
        document.getElementById('input-image-upload').addEventListener('change', (e) => this.handleMediaUpload(e.target.files[0], 'image'));
        document.getElementById('input-file-upload').addEventListener('change', (e) => this.handleMediaUpload(e.target.files[0], 'file'));

        // Emoji & Dynamic Picker drawer toggle
        document.getElementById('btn-emoji-toggle').addEventListener('click', () => {
            this.toggleElementDisplay('emoji-picker-container');
            this.loadEmojis();
        });
        document.getElementById('emoji-pick-tab').addEventListener('click', () => this.switchPickerTab('emojis'));
        document.getElementById('gif-pick-tab').addEventListener('click', () => this.switchPickerTab('gifs'));

        // Group management toggles
        document.getElementById('btn-trigger-group-modal').addEventListener('click', () => this.toggleGroupModal(true));
        document.getElementById('btn-cancel-group').addEventListener('click', () => this.toggleGroupModal(false));
        document.getElementById('btn-confirm-group').addEventListener('click', () => this.createGroup());

        // Voice Message recording actions
        document.getElementById('btn-voice-record').addEventListener('mousedown', () => this.startVoiceRecording());
        document.getElementById('btn-voice-record').addEventListener('mouseup', () => this.stopVoiceRecording(false));
        document.getElementById('btn-voice-record').addEventListener('mouseleave', () => this.stopVoiceRecording(true));

        // Stories media input uploads
        document.getElementById('btn-add-story').addEventListener('click', () => {
            document.getElementById('input-story-file').click();
        });
        document.getElementById('input-story-file').addEventListener('change', (e) => this.postStory(e.target.files[0]));

        // Story modal view toggles
        document.getElementById('btn-close-story').addEventListener('click', () => {
            this.toggleElementDisplay('story-viewer-modal', false);
        });
        document.getElementById('btn-send-story-reply').addEventListener('click', () => this.sendStoryReply());

        // Calling initiators (ZEGOCLOUD)
        document.getElementById('btn-call-voice').addEventListener('click', () => this.initiateCall('voice'));
        document.getElementById('btn-call-video').addEventListener('click', () => this.initiateCall('video'));
        document.getElementById('btn-terminate-call').addEventListener('click', () => this.terminateZegoCall());

        // Messaging actions
        document.getElementById('btn-send-message').addEventListener('click', () => this.sendMessage());
        document.getElementById('message-text-input').addEventListener('input', (e) => {
            this.handleTyping();
            document.getElementById('btn-send-message').classList.toggle('hidden', e.target.value.trim() === '');
        });

        // Cancel Reply Button
        document.getElementById('btn-cancel-reply').addEventListener('click', () => this.cancelReplyState());

        // Detail drawers
        document.getElementById('btn-toggle-info').addEventListener('click', () => {
            this.toggleElementDisplay('info-drawer');
            this.loadDrawerDetails();
        });
        document.getElementById('btn-close-drawer').addEventListener('click', () => {
            this.toggleElementDisplay('info-drawer', false);
        });

        // Theme controllers
        document.getElementById('btn-toggle-theme').addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
        });

        // Admin Panel Controls
        document.getElementById('btn-admin-panel').addEventListener('click', () => this.openAdminDashboard());
        document.getElementById('btn-close-admin').addEventListener('click', () => {
            this.toggleElementDisplay('admin-dashboard-modal', false);
        });

        // Global context menu closer
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#msg-context-menu')) {
                this.toggleElementDisplay('msg-context-menu', false);
            }
        });

        document.getElementById('btn-unpin-current').addEventListener('click', () => this.unpinMessage());
    }

    run() {
        onAuthStateChanged(this.auth, async (user) => {
            if (user) {
                const userDoc = await getDoc(doc(this.db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().banned) {
                    this.showToast("Your account has been restricted.", "error");
                    signOut(this.auth);
                    return;
                }

                this.currentUser = user;
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('app-screen').classList.remove('hidden');
                
                document.getElementById('current-user-avatar').src = user.photoURL;
                document.getElementById('current-user-name').textContent = user.displayName;

                this.syncUserProfile(user);
                this.setupPresence();
                this.loadSidebarList('chats');
                this.listenForIncomingCalls();
                this.listenForStories();
                this.registerPushNotifications();
                
                if (userDoc.exists() && userDoc.data().role === 'admin') {
                    document.getElementById('btn-admin-panel').classList.remove('hidden');
                }

                // Link user context to OneSignal Web Push
                if (CONFIG.onesignal.appId && CONFIG.onesignal.appId !== "YOUR_ONESIGNAL_APP_ID") {
                    window.OneSignalDeferred = window.OneSignalDeferred || [];
                    OneSignalDeferred.push(async function(OneSignal) {
                        await OneSignal.login(user.uid);
                    });
                }

                lucide.createIcons();
            } else {
                document.getElementById('auth-screen').classList.remove('hidden');
                document.getElementById('app-screen').classList.add('hidden');
            }
        });
    }

    showToast(message, type = "info") {
        const toast = document.createElement('div');
        toast.className = `toast-notice fixed bottom-6 left-6 z-[120] flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl border text-sm font-semibold transition-all ${
            type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-slate-900 dark:bg-dark-800 text-white dark:text-slate-200 border-white/10 dark:border-purple-950/20 shadow-neon-glow'
        }`;
        toast.innerHTML = `<i data-lucide="${type === 'error' ? 'alert-triangle' : 'info'}" class="w-4 h-4"></i><span>${message}</span>`;
        document.body.appendChild(toast);
        lucide.createIcons();
        setTimeout(() => toast.remove(), 4000);
    }

    toggleElementDisplay(id, show = null) {
        const el = document.getElementById(id);
        if (!el) return;
        if (show === null) {
            el.classList.toggle('hidden');
        } else {
            if (show) el.classList.remove('hidden');
            else el.classList.add('hidden');
        }
    }

    // =========================================================================
    // DYNAMIC LAYOUT ENGINE (PC vs Mobile View Toggle)
    // =========================================================================
    enterActiveChatMobile() {
        const chatWindow = document.getElementById('chat-window');
        const sidebar = document.getElementById('app-sidebar');

        // Always show the active conversation container
        chatWindow.classList.remove('hidden');
        chatWindow.classList.add('flex');

        // On smaller viewports (Mobile), hide the sidebar to clear screen space
        if (window.innerWidth < 768) {
            sidebar.classList.add('hidden');
        } else {
            // Keep both visible on Desktop / PC
            sidebar.classList.remove('hidden');
        }
        
        const scroller = document.getElementById('messages-scroller');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    exitActiveChatMobile() {
        const chatWindow = document.getElementById('chat-window');
        const sidebar = document.getElementById('app-sidebar');

        if (this.activeMessagesListener) {
            this.activeMessagesListener();
            this.activeMessagesListener = null;
        }

        this.activeChatId = null;
        this.activeTargetUser = null;

        // Restore layout states based on screen size
        if (window.innerWidth < 768) {
            sidebar.classList.remove('hidden');
            chatWindow.classList.add('hidden');
            chatWindow.classList.remove('flex');
        } else {
            sidebar.classList.remove('hidden');
            chatWindow.classList.remove('hidden');
            chatWindow.classList.add('flex');
        }

        document.getElementById('chat-idle-state').classList.remove('hidden');
        document.getElementById('chat-active-state').classList.add('hidden');
    }

    // =========================================================================
    // GOOGLE AUTH CONTROLLERS
    // =========================================================================
    async signInGoogle() {
        try {
            const provider = new GoogleAuthProvider();
            await signInWithPopup(this.auth, provider);
        } catch (error) {
            this.showToast("Google Sign-In failed.", "error");
        }
    }

    async signOutUser() {
        if (this.currentUser) {
            await updateDoc(doc(this.db, "users", this.currentUser.uid), {
                onlineStatus: false,
                lastSeen: serverTimestamp()
            });
        }
        
        if (CONFIG.onesignal.appId && CONFIG.onesignal.appId !== "YOUR_ONESIGNAL_APP_ID") {
            window.OneSignalDeferred = window.OneSignalDeferred || [];
            OneSignalDeferred.push(async function(OneSignal) {
                await OneSignal.logout();
            });
        }

        clearInterval(this.presenceInterval);
        signOut(this.auth);
    }

    async syncUserProfile(user) {
        const userRef = doc(this.db, "users", user.uid);
        const snapshot = await getDoc(userRef);
        
        const payload = {
            uid: user.uid,
            displayName: user.displayName,
            photoURL: user.photoURL,
            email: user.email,
            lastSeen: serverTimestamp(),
            onlineStatus: true
        };

        if (!snapshot.exists()) {
            payload.createdAt = serverTimestamp();
            payload.bio = "Hey there! I am using Nexus.";
            payload.role = "user";
            payload.banned = false;
        }

        await setDoc(userRef, payload, { merge: true });
    }

    setupPresence() {
        const updatePresence = async () => {
            if (!this.currentUser) return;
            await updateDoc(doc(this.db, "users", this.currentUser.uid), {
                lastSeen: serverTimestamp(),
                onlineStatus: true
            });
        };

        updatePresence();
        this.presenceInterval = setInterval(updatePresence, 30000);
    }

    // =========================================================================
    // ADAPTIVE SECURE FILE STORAGE UPLOAD DIRECT TO R2
    // =========================================================================
    async uploadToR2(file) {
        const fileExtension = file.name.split('.').pop();
        const uniqueKey = `nexus_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${fileExtension}`;
        const baseDomain = CONFIG.cloudflareR2.publicUrlDomain.replace(/\/+$/, "");

        // Mode A: Secure Cloudflare Worker upload proxy
        if (CONFIG.cloudflareR2.workerUploadUrl) {
            const cleanWorkerUrl = CONFIG.cloudflareR2.workerUploadUrl.replace(/\/+$/, "");
            const uploadUrl = `${cleanWorkerUrl}/?file=${uniqueKey}`;
            
            const response = await fetch(uploadUrl, {
                method: 'PUT',
                body: file,
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Auth-Token': CONFIG.cloudflareR2.uploadSecretToken || ""
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || "Upload failed via Worker proxy.");
            }
            return `${baseDomain}/${uniqueKey}`;
        }

        // Mode B: Client-side Direct S3 SDK fallback
        if (!this.s3Client) {
            this.showToast("R2 Storage configuration missing.", "error");
            throw new Error("R2 configuration missing");
        }

        const uploadParams = {
            Bucket: CONFIG.cloudflareR2.bucketName,
            Key: uniqueKey,
            Body: file,
            ContentType: file.type
        };

        return new Promise((resolve, reject) => {
            this.s3Client.upload(uploadParams, (err, data) => {
                if (err) {
                    this.showToast("Error uploading file.", "error");
                    reject(err);
                } else {
                    resolve(`${baseDomain}/${uniqueKey}`);
                }
            });
        });
    }

    // =========================================================================
    // SIDEBAR & DIRECT CHAT / GROUPS UI
    // =========================================================================
    switchSidebarTab(event, tabType) {
        const tabs = ['tab-chats', 'tab-groups', 'tab-users'];
        tabs.forEach(id => {
            const btn = document.getElementById(id);
            if (id === `tab-${tabType}`) {
                btn.className = "flex-1 py-2 text-xs font-bold rounded-xl bg-white dark:bg-brand-600/90 shadow-md text-center transition-all";
            } else {
                btn.className = "flex-1 py-2 text-xs font-bold rounded-xl text-slate-500 dark:text-slate-400 text-center transition-all";
            }
        });
        this.loadSidebarList(tabType);
    }

    async loadSidebarList(tabType) {
        const container = document.getElementById('sidebar-list-container');
        container.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">Loading ${tabType}...</div>`;

        if (tabType === 'users') {
            const q = query(collection(this.db, "users"), limit(50));
            onSnapshot(q, (snapshot) => {
                container.innerHTML = "";
                snapshot.forEach(docSnap => {
                    const usr = docSnap.data();
                    if (usr.uid === this.currentUser.uid || usr.banned) return;
                    
                    const el = document.createElement('div');
                    el.className = "flex items-center gap-3.5 p-3.5 hover:bg-slate-100 dark:hover:bg-dark-800/40 rounded-2xl cursor-pointer transition-all";
                    el.innerHTML = `
                        <div class="relative flex-shrink-0">
                            <img class="w-12 h-12 rounded-[18px] object-cover border border-slate-200 dark:border-purple-950/20 shadow-sm" src="${usr.photoURL}">
                            <span class="w-3.5 h-3.5 border-2 border-white dark:border-dark-900 rounded-full absolute -bottom-1 -right-1 ${usr.onlineStatus ? 'bg-green-500' : 'bg-slate-400'}"></span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h4 class="font-bold text-sm truncate">${usr.displayName}</h4>
                            <span class="text-xs text-slate-500 block truncate">${usr.bio || ""}</span>
                        </div>
                    `;
                    el.addEventListener('click', () => this.openPrivateChat(usr));
                    container.appendChild(el);
                });
            });
        } 
        else if (tabType === 'groups') {
            // Firestore containment operator fix [firestore]
            const q = query(
                collection(this.db, "groups"), 
                where("members", "array-contains", this.currentUser.uid)
            );
            onSnapshot(q, (snapshot) => {
                container.innerHTML = "";
                if (snapshot.empty) {
                    container.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">No Groups Joined. Create one!</div>`;
                    return;
                }
                snapshot.forEach(docSnap => {
                    const group = docSnap.data();
                    const el = document.createElement('div');
                    el.className = "flex items-center gap-3.5 p-3.5 hover:bg-slate-100 dark:hover:bg-dark-800/40 rounded-2xl cursor-pointer transition-all";
                    el.innerHTML = `
                        <div class="w-12 h-12 rounded-[18px] bg-gradient-to-r from-brand-600 to-indigo-600 text-white flex items-center justify-center font-extrabold text-lg flex-shrink-0 shadow-sm">
                            ${group.name.substring(0, 2).toUpperCase()}
                        </div>
                        <div class="flex-1 min-w-0">
                            <h4 class="font-bold text-sm truncate">${group.name}</h4>
                            <span class="text-xs text-slate-500 block truncate font-medium">${group.members.length} members</span>
                        </div>
                    `;
                    el.addEventListener('click', () => this.openGroupChat(group));
                    container.appendChild(el);
                });
            });
        } 
        else if (tabType === 'chats') {
            // Firestore containment operator fix [firestore]
            const q = query(
                collection(this.db, "privateChats"), 
                where("participants", "array-contains", this.currentUser.uid), 
                orderBy("lastMessageTime", "desc")
            );
            onSnapshot(q, async (snapshot) => {
                container.innerHTML = "";
                if (snapshot.empty) {
                    container.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">No active rooms. Start a conversation!</div>`;
                    return;
                }
                for (const docSnap of snapshot.docs) {
                    const chat = docSnap.data();
                    const targetId = chat.participants.find(id => id !== this.currentUser.uid);
                    if (!targetId) continue;

                    const usrSnap = await getDoc(doc(this.db, "users", targetId));
                    if (!usrSnap.exists() || usrSnap.data().banned) continue;
                    const targetUsr = usrSnap.data();

                    const el = document.createElement('div');
                    el.className = "flex items-center gap-3.5 p-3.5 hover:bg-slate-100 dark:hover:bg-dark-800/40 rounded-2xl cursor-pointer transition-all";
                    el.innerHTML = `
                        <div class="relative flex-shrink-0">
                            <img class="w-12 h-12 rounded-[18px] object-cover border border-slate-200 dark:border-purple-950/20" src="${targetUsr.photoURL}">
                            <span class="w-3.5 h-3.5 border-2 border-white dark:border-dark-900 rounded-full absolute -bottom-1 -right-1 ${targetUsr.onlineStatus ? 'bg-green-500' : 'bg-slate-400'}"></span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex justify-between items-baseline mb-0.5">
                                <h4 class="font-bold text-sm truncate mr-1">${targetUsr.displayName}</h4>
                                <span class="text-[10px] text-slate-400 font-bold flex-shrink-0">${chat.lastMessageTime ? new Date(chat.lastMessageTime.toDate()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ""}</span>
                            </div>
                            <p class="text-xs text-slate-500 truncate font-medium">${chat.lastMessageText || "Sent an attachment"}</p>
                        </div>
                    `;
                    el.addEventListener('click', () => this.openPrivateChat(targetUsr));
                    container.appendChild(el);
                }
            });
        }
    }

    // =========================================================================
    // PRIVATE CHAT LOGIC IMPLEMENTATION
    // =========================================================================
    async openPrivateChat(targetUser) {
        if (this.activeMessagesListener) this.activeMessagesListener();

        this.activeChatType = 'private';
        this.activeTargetUser = targetUser;
        this.activeChatId = [this.currentUser.uid, targetUser.uid].sort().join('_');

        document.getElementById('chat-idle-state').classList.add('hidden');
        document.getElementById('chat-active-state').classList.remove('hidden');

        document.getElementById('active-target-avatar').src = targetUser.photoURL;
        document.getElementById('active-target-name').textContent = targetUser.displayName;
        document.getElementById('active-target-status').textContent = targetUser.onlineStatus ? 'Active Now' : 'Offline';

        this.listenForMessages();
        this.loadPinnedMessage();
        
        this.enterActiveChatMobile();
    }

    // =========================================================================
    // REAL-TIME MESSAGES SUBSCRIBER WITH IN-MEMORY SORT
    // =========================================================================
    listenForMessages() {
        const scroller = document.getElementById('messages-scroller');
        
        const q = query(
            collection(this.db, "messages"), 
            where("chatId", "==", this.activeChatId)
        );

        this.activeMessagesListener = onSnapshot(q, (snapshot) => {
            scroller.innerHTML = "";
            let msgs = [];
            
            snapshot.forEach(docSnap => {
                const data = docSnap.data();
                data.id = docSnap.id;
                msgs.push(data);
            });

            msgs.sort((a, b) => {
                const timeA = a.timestamp ? a.timestamp.toMillis() : Date.now();
                const timeB = b.timestamp ? b.timestamp.toMillis() : Date.now();
                return timeA - timeB;
            });

            msgs.forEach(msg => {
                this.renderMessageBubble(msg);
            });

            scroller.scrollTop = scroller.scrollHeight;
            lucide.createIcons();
            this.markMessagesAsRead();
        });
    }

    renderMessageBubble(msg) {
        const scroller = document.getElementById('messages-scroller');
        const isSelf = msg.senderId === this.currentUser.uid;
        
        const wrap = document.createElement('div');
        wrap.className = `flex flex-col ${isSelf ? 'items-end' : 'items-start'} space-y-1 relative group w-full mb-3`;
        wrap.setAttribute('data-msg-id', msg.id);

        let contentHtml = "";

        const safeMediaUrl = this.ensureAbsoluteUrl(msg.mediaUrl);

        if (msg.mediaType === 'image') {
            contentHtml = `
                <div class="relative overflow-hidden rounded-2xl bg-slate-200/50 dark:bg-dark-900/80 border border-slate-200 dark:border-purple-950/40 w-64 h-48 flex items-center justify-center shadow-md">
                    <img src="${safeMediaUrl}" class="w-full h-full object-cover cursor-zoom-in transition-all hover:scale-105 duration-300" 
                         onerror="this.onerror=null; this.src='https://api.dicebear.com/7.x/initials/svg?seed=MediaError&backgroundColor=b892ff'; this.parentElement.classList.add('opacity-50');" 
                         onclick="window.open('${safeMediaUrl}')" 
                         loading="lazy">
                </div>
            `;
        } else if (msg.mediaType === 'file') {
            contentHtml = `
                <a href="${safeMediaUrl}" target="_blank" class="flex items-center gap-3.5 p-3 bg-slate-100 dark:bg-dark-800 rounded-2xl hover:bg-slate-200 dark:hover:bg-dark-750 transition-colors">
                    <div class="p-2.5 bg-brand-500/10 text-brand-500 rounded-xl flex-shrink-0"><i data-lucide="file-text" class="w-5.5 h-5.5"></i></div>
                    <div class="text-left min-w-0">
                        <span class="text-xs font-bold block truncate max-w-[150px] text-slate-800 dark:text-slate-200">${msg.fileName || "Download Attachment"}</span>
                        <span class="text-[10px] text-slate-400 block font-semibold">${msg.fileSize ? (msg.fileSize/1024/1024).toFixed(2) + " MB" : ""}</span>
                    </div>
                </a>
            `;
        } else if (msg.mediaType === 'voice') {
            contentHtml = `
                <div class="flex items-center gap-3.5 p-3.5 bg-brand-500/10 text-brand-500 dark:text-brand-400 rounded-2xl border border-brand-500/10 shadow-sm w-72">
                    <button class="voice-play-trigger p-2.5 bg-brand-500 text-white rounded-full transition-transform hover:scale-105 flex-shrink-0 shadow-neon-brand" data-audio-url="${safeMediaUrl}">
                        <i data-lucide="play" class="w-4 h-4"></i>
                    </button>
                    <div class="flex-1 flex items-center gap-1 h-6 px-2 overflow-hidden">
                        <span class="soundwave-bar w-1 h-3 bg-brand-500/30 dark:bg-brand-400/30 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-5 bg-brand-500/40 dark:bg-brand-400/40 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-4 bg-brand-500/50 dark:bg-brand-400/50 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-6 bg-brand-500 dark:bg-brand-400 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-5 bg-brand-500 dark:bg-brand-400 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-4 bg-brand-500/50 dark:bg-brand-400/50 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-5 bg-brand-500/40 dark:bg-brand-400/40 rounded-full"></span>
                        <span class="soundwave-bar w-1 h-3 bg-brand-500/30 dark:bg-brand-400/30 rounded-full"></span>
                    </div>
                    <span class="text-[10px] font-bold text-brand-500/80 tracking-wider">AUDIO</span>
                </div>
            `;
        } else {
            const sanitizedText = this.escapeHTML(msg.text);
            contentHtml = `<p class="text-sm leading-relaxed break-words font-medium">${sanitizedText}</p>`;
        }

        let rxHtml = "";
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
            const rxCounts = {};
            Object.values(msg.reactions).forEach(emoji => rxCounts[emoji] = (rxCounts[emoji] || 0) + 1);
            const rxs = Object.keys(rxCounts).map(emoji => `<span class="bg-white dark:bg-dark-800 border border-slate-200 dark:border-purple-950/40 px-2 py-0.5 rounded-full text-[10px]">${emoji} ${rxCounts[emoji]}</span>`).join('');
            rxHtml = `<div class="flex gap-1 mt-1 absolute -bottom-3 ${isSelf ? 'right-2' : 'left-2'} z-10">${rxs}</div>`;
        }

        let replyHeaderHtml = "";
        if (msg.replyTo) {
            replyHeaderHtml = `
                <div class="border-l-2 border-brand-500 pl-2.5 py-0.5 mb-1.5 bg-slate-500/5 rounded text-left">
                    <span class="text-[10px] font-bold text-brand-500 block">${msg.replyTo.senderName}</span>
                    <span class="text-[10px] text-slate-400 truncate block max-w-[150px] font-semibold">${msg.replyTo.text || "Attachment"}</span>
                </div>
            `;
        }

        wrap.innerHTML = `
            ${isSelf ? '' : `<span class="text-[10px] font-bold text-slate-400 pl-1 mb-0.5">${msg.senderName}</span>`}
            <div class="flex items-center gap-2 max-w-[85%] md:max-w-[70%]">
                <div class="message-bubble py-3 px-5 rounded-3xl shadow-sm text-left relative ${
                    isSelf 
                    ? 'bg-gradient-to-r from-brand-600 to-indigo-600 text-white message-bubble-out shadow-neon-brand' 
                    : 'bg-white dark:bg-dark-800/80 border border-slate-200/50 dark:border-purple-950/20 message-bubble-in shadow-sm'
                }">
                    ${replyHeaderHtml}
                    ${contentHtml}
                    <div class="flex items-center justify-end gap-1 mt-1.5 text-[9px] text-slate-400 font-bold">
                        <span>${msg.timestamp ? new Date(msg.timestamp.toDate()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ""}</span>
                        ${msg.editedAt ? `<span>(Edited)</span>` : ''}
                        ${isSelf ? `<i data-lucide="${msg.isReadByAll ? 'check-check' : 'check'}" class="w-3.5 h-3.5 ${msg.isReadByAll ? 'text-blue-400' : 'text-slate-400'}"></i>` : ""}
                    </div>
                </div>
            </div>
            ${rxHtml}
        `;

        wrap.addEventListener('contextmenu', (e) => this.openContextMenu(e, msg));
        
        const audioBtn = wrap.querySelector('.voice-play-trigger');
        if (audioBtn) {
            audioBtn.addEventListener('click', (e) => this.playVoiceMessage(e, audioBtn));
        }

        scroller.appendChild(wrap);
    }

    escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
        );
    }

    // =========================================================================
    // CONTEXT MENUS ACTIONS (REPLY, STAR, EDIT, DELETE, FORWARD, PIN)
    // =========================================================================
    openContextMenu(e, msg) {
        e.preventDefault();
        const menu = document.getElementById('msg-context-menu');
        menu.style.top = `${e.clientY}px`;
        menu.style.left = `${e.clientX}px`;
        this.toggleElementDisplay('msg-context-menu', true);

        document.getElementById('ctx-reply').onclick = () => this.initiateReply(msg);
        document.getElementById('ctx-edit').onclick = () => this.initiateEdit(msg);
        document.getElementById('ctx-star').onclick = () => this.starMessage(msg);
        document.getElementById('ctx-pin').onclick = () => this.pinMessage(msg);
        document.getElementById('ctx-copy').onclick = () => {
            navigator.clipboard.writeText(msg.text || "");
            this.showToast("Message copied to clipboard.");
        };
        document.getElementById('ctx-forward').onclick = () => this.openForwardSelector(msg);
        document.getElementById('ctx-delete').onclick = () => this.deleteMessage(msg);

        document.getElementById('ctx-edit').classList.toggle('hidden', msg.senderId !== this.currentUser.uid);
        document.getElementById('ctx-delete').classList.toggle('hidden', msg.senderId !== this.currentUser.uid);
    }

    initiateReply(msg) {
        this.activeReplyMessage = msg;
        const bar = document.getElementById('reply-context-bar');
        document.getElementById('reply-user-title').textContent = msg.senderName;
        document.getElementById('reply-preview-text').textContent = msg.text || "Attachment";
        bar.classList.remove('hidden');
    }

    cancelReplyState() {
        this.activeReplyMessage = null;
        document.getElementById('reply-context-bar').classList.add('hidden');
    }

    async initiateEdit(msg) {
        const input = document.getElementById('message-text-input');
        input.value = msg.text || "";
        input.focus();
        
        const sendBtn = document.getElementById('btn-send-message');
        sendBtn.classList.remove('hidden');
        sendBtn.onclick = async () => {
            if (input.value.trim() !== "") {
                await updateDoc(doc(this.db, "messages", msg.id), {
                    text: input.value,
                    editedAt: serverTimestamp()
                });
                this.showToast("Message edited.");
                input.value = "";
                sendBtn.onclick = () => this.sendMessage();
            }
        };
    }

    async starMessage(msg) {
        await updateDoc(doc(this.db, "messages", msg.id), {
            isStarredBy: arrayUnion(this.currentUser.uid)
        });
        this.showToast("Message Starred.");
    }

    async pinMessage(msg) {
        const q = query(collection(this.db, "messages"), where("chatId", "==", this.activeChatId), where("isPinned", "==", true));
        const snapshots = await getDocs(q);
        for (const snap of snapshots.docs) {
            await updateDoc(doc(this.db, "messages", snap.id), { isPinned: false });
        }
        await updateDoc(doc(this.db, "messages", msg.id), { isPinned: true });
        this.showToast("Message Pinned.");
        this.loadPinnedMessage();
    }

    async loadPinnedMessage() {
        const q = query(collection(this.db, "messages"), where("chatId", "==", this.activeChatId), where("isPinned", "==", true), limit(1));
        onSnapshot(q, (snapshot) => {
            const bar = document.getElementById('pinned-message-bar');
            if (snapshot.empty) {
                bar.classList.add('hidden');
                return;
            }
            const pinned = snapshot.docs[0].data();
            pinned.id = snapshot.docs[0].id;
            document.getElementById('pinned-message-text').textContent = pinned.text || "Attachment File";
            bar.classList.remove('hidden');
            
            bar.onclick = () => {
                const targetNode = document.querySelector(`[data-msg-id="${pinned.id}"]`);
                if (targetNode) targetNode.scrollIntoView({ behavior: 'smooth' });
            };
        });
    }

    async unpinMessage() {
        const q = query(collection(this.db, "messages"), where("chatId", "==", this.activeChatId), where("isPinned", "==", true));
        const snapshots = await getDocs(q);
        for (const snap of snapshots.docs) {
            await updateDoc(doc(this.db, "messages", snap.id), { isPinned: false });
        }
        this.showToast("Unpinned message.");
    }

    async deleteMessage(msg) {
        await deleteDoc(doc(this.db, "messages", msg.id));
        this.showToast("Message Deleted.");
    }

    async openForwardSelector(msg) {
        const targetUserUid = prompt("Enter target contact Email address to forward message:");
        if (!targetUserUid) return;
        
        const q = query(collection(this.db, "users"), where("email", "==", targetUserUid));
        const snapshots = await getDocs(q);
        if (snapshots.empty) {
            this.showToast("User not found.", "error");
            return;
        }

        const forwardTarget = snapshots.docs[0].data();
        const generatedChatId = [this.currentUser.uid, forwardTarget.uid].sort().join('_');

        await addDoc(collection(this.db, "messages"), {
            chatId: generatedChatId,
            senderId: this.currentUser.uid,
            senderName: this.currentUser.displayName,
            text: `[Forwarded] ${msg.text || ""}`,
            mediaUrl: msg.mediaUrl || null,
            mediaType: msg.mediaType || null,
            timestamp: serverTimestamp()
        });
        this.showToast("Message Forwarded.");
    }

    // =========================================================================
    // SEND MESSAGE CONSTRUCTORS
    // =========================================================================
    async sendMessage() {
        const input = document.getElementById('message-text-input');
        const text = input.value.trim();
        if (text === "") return;

        const payload = {
            chatId: this.activeChatId,
            senderId: this.currentUser.uid,
            senderName: this.currentUser.displayName,
            text: text,
            timestamp: serverTimestamp(),
            reactions: {},
            isPinned: false,
            isReadByAll: false
        };

        if (this.activeReplyMessage) {
            payload.replyTo = {
                id: this.activeReplyMessage.id,
                senderName: this.activeReplyMessage.senderName,
                text: this.activeReplyMessage.text || "Attachment"
            };
            this.cancelReplyState();
        }

        input.value = "";
        document.getElementById('btn-send-message').classList.add('hidden');

        await addDoc(collection(this.db, "messages"), payload);

        const recentsRef = doc(this.db, "privateChats", this.activeChatId);
        await setDoc(recentsRef, {
            participants: [this.currentUser.uid, this.activeTargetUser ? this.activeTargetUser.uid : null].filter(Boolean),
            lastMessageText: text,
            lastMessageTime: serverTimestamp()
        }, { merge: true });

        this.triggerPresenceEvent('none');
    }

    // =========================================================================
    // TYPING / RECORDING STATUS ENGINE
    // =========================================================================
    handleTyping() {
        this.triggerPresenceEvent('typing');
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => this.triggerPresenceEvent('none'), 3000);
    }

    async triggerPresenceEvent(status) {
        if (!this.activeChatId) return;
        const statusRef = doc(this.db, "presence", `${this.activeChatId}_${this.currentUser.uid}`);
        await setDoc(statusRef, {
            userId: this.currentUser.uid,
            userName: this.currentUser.displayName,
            chatId: this.activeChatId,
            status: status,
            timestamp: serverTimestamp()
        });
    }

    listenForTyping(chatId) {
        const q = query(collection(this.db, "presence"), where("chatId", "==", chatId));
        onSnapshot(q, (snapshot) => {
            const bar = document.getElementById('typing-indicator-bar');
            const txt = document.getElementById('typing-indicator-text');
            let active = [];
            
            snapshot.forEach(docSnap => {
                const presence = docSnap.data();
                if (presence.userId !== this.currentUser.uid && presence.status !== 'none') {
                    active.push(`${presence.userName} is ${presence.status}...`);
                }
            });

            if (active.length > 0) {
                txt.textContent = active.join(', ');
                bar.classList.remove('hidden');
            } else {
                bar.classList.add('hidden');
            }
        });
    }

    async markMessagesAsRead() {
        const q = query(
            collection(this.db, "messages"), 
            where("chatId", "==", this.activeChatId), 
            where("senderId", "!=", this.currentUser.uid)
        );
        const snapshots = await getDocs(q);
        snapshots.forEach(async (snap) => {
            await updateDoc(doc(this.db, "messages", snap.id), {
                isReadByAll: true
            });
        });
    }

    // =========================================================================
    // VOICE MESSAGES PLAYER & RECORDER
    // =========================================================================
    async startVoiceRecording() {
        if (!navigator.mediaDevices) {
            this.showToast("Audio capture media permissions not supported.", "error");
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.voiceRecorder = new MediaRecorder(stream);
            this.voiceChunks = [];
            
            this.voiceRecorder.ondataavailable = (e) => this.voiceChunks.push(e.data);
            this.voiceRecorder.onstop = async () => {
                const audioBlob = new Blob(this.voiceChunks, { type: 'audio/mp3' });
                this.showToast("Uploading Voice Message...");
                const url = await this.uploadToR2(audioBlob);
                
                await addDoc(collection(this.db, "messages"), {
                    chatId: this.activeChatId,
                    senderId: this.currentUser.uid,
                    senderName: this.currentUser.displayName,
                    mediaUrl: url,
                    mediaType: 'voice',
                    timestamp: serverTimestamp()
                });
            };

            this.voiceRecorder.start();
            document.getElementById('voice-record-pulse').classList.remove('hidden');
            this.triggerPresenceEvent('recording');
        } catch (error) {
            this.showToast("Mic access denied.", "error");
        }
    }

    stopVoiceRecording(isCancelled = false) {
        if (this.voiceRecorder && this.voiceRecorder.state !== 'inactive') {
            if (isCancelled) {
                this.voiceRecorder.ondataavailable = null;
                this.voiceChunks = [];
                this.showToast("Voice message cancelled.");
            }
            this.voiceRecorder.stop();
            this.voiceRecorder.stream.getTracks().forEach(track => track.stop());
            document.getElementById('voice-record-pulse').classList.add('hidden');
            this.triggerPresenceEvent('none');
        }
    }

    playVoiceMessage(e, btn) {
        const url = btn.getAttribute('data-audio-url');
        const icon = btn.querySelector('i');
        const bubbleWrapper = btn.closest('.message-bubble');
        
        if (btn.audioInstance && !btn.audioInstance.paused) {
            btn.audioInstance.pause();
            icon.setAttribute('data-lucide', 'play');
            if (bubbleWrapper) bubbleWrapper.classList.remove('voice-playing');
        } else {
            if (!btn.audioInstance) {
                btn.audioInstance = new Audio(url);
                btn.audioInstance.onended = () => {
                    icon.setAttribute('data-lucide', 'play');
                    if (bubbleWrapper) bubbleWrapper.classList.remove('voice-playing');
                    lucide.createIcons();
                };
            }
            btn.audioInstance.play();
            icon.setAttribute('data-lucide', 'pause');
            if (bubbleWrapper) bubbleWrapper.classList.add('voice-playing');
        }
        lucide.createIcons();
    }

    // =========================================================================
    // DYNAMIC MEDIA FILE UPLOAD HANDLERS
    // =========================================================================
    async handleMediaUpload(file, type) {
        if (!file) return;
        this.showToast("Uploading media asset...");
        try {
            const url = await this.uploadToR2(file);
            await addDoc(collection(this.db, "messages"), {
                chatId: this.activeChatId,
                senderId: this.currentUser.uid,
                senderName: this.currentUser.displayName,
                mediaUrl: url,
                mediaType: type,
                fileName: file.name,
                fileSize: file.size,
                timestamp: serverTimestamp()
            });
            this.showToast("Upload Successful!");
        } catch (error) {
            this.showToast("Could not complete media upload.", "error");
        }
    }

    // =========================================================================
    // STICKERS & NATIVE EMOJI CONTROLS
    // =========================================================================
    loadEmojis() {
        const scroller = document.getElementById('emoji-scroll-content');
        if (scroller.children.length > 0) return;

        const emojiRange = [
            "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰",
            "😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🤩","🥳","😏",
            "😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠"
        ];

        emojiRange.forEach(emoji => {
            const el = document.createElement('span');
            el.textContent = emoji;
            el.className = "hover:scale-125 transition-transform text-center p-1 select-none";
            el.addEventListener('click', () => {
                const input = document.getElementById('message-text-input');
                input.value += emoji;
                input.focus();
                document.getElementById('btn-send-message').classList.remove('hidden');
            });
            scroller.appendChild(el);
        });
    }

    switchPickerTab(tab) {
        if (tab === 'emojis') {
            document.getElementById('emoji-scroll-content').classList.remove('hidden');
            document.getElementById('gif-scroll-content').classList.add('hidden');
            document.getElementById('emoji-pick-tab').className = "flex-1 py-1.5 text-xs font-bold rounded-lg bg-white dark:bg-slate-800 shadow-md text-center";
            document.getElementById('gif-pick-tab').className = "flex-1 py-1.5 text-xs font-bold rounded-lg text-slate-500 text-center";
        } else {
            document.getElementById('emoji-scroll-content').classList.add('hidden');
            document.getElementById('gif-scroll-content').classList.remove('hidden');
            document.getElementById('gif-pick-tab').className = "flex-1 py-1.5 text-xs font-bold rounded-lg bg-white dark:bg-slate-800 shadow-md text-center";
            document.getElementById('emoji-pick-tab').className = "flex-1 py-1.5 text-xs font-bold rounded-lg text-slate-500 text-center";
            this.loadGifs();
        }
    }

    loadGifs() {
        const container = document.getElementById('gif-scroll-content');
        if (container.children.length > 0) return;

        const stickerUrls = [
            "https://media.giphy.com/media/3o7qE1YN7aBOFPRw8E/giphy.gif",
            "https://media.giphy.com/media/l41lI4bYV6tb0gXN6/giphy.gif",
            "https://media.giphy.com/media/3o7TKDkEg0998hI6L6/giphy.gif",
            "https://media.giphy.com/media/xT39C1MKB7t6nup69y/giphy.gif"
        ];

        stickerUrls.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.className = "w-full h-24 rounded-lg object-cover hover:opacity-80 transition-opacity";
            img.addEventListener('click', () => {
                addDoc(collection(this.db, "messages"), {
                    chatId: this.activeChatId,
                    senderId: this.currentUser.uid,
                    senderName: this.currentUser.displayName,
                    mediaUrl: url,
                    mediaType: 'image',
                    timestamp: serverTimestamp()
                });
                this.toggleElementDisplay('emoji-picker-container', false);
            });
            container.appendChild(img);
        });
    }

    // =========================================================================
    // GROUP SYSTEM MANAGEMENT MODULE
    // =========================================================================
    toggleGroupModal(show) {
        this.toggleElementDisplay('group-creator-modal', show);
        if (show) this.populateGroupUserOptions();
    }

    async populateGroupUserOptions() {
        const container = document.getElementById('group-user-selection-list');
        container.innerHTML = "";

        const q = query(collection(this.db, "users"), limit(100));
        const snapshots = await getDocs(q);
        snapshots.forEach(docSnap => {
            const usr = docSnap.data();
            if (usr.uid === this.currentUser.uid) return;
            
            const div = document.createElement('div');
            div.className = "flex items-center gap-3 py-1";
            div.innerHTML = `
                <input type="checkbox" value="${usr.uid}" class="group-select-checkbox rounded text-brand-500 focus:ring-brand-500">
                <img class="w-8 h-8 rounded-full" src="${usr.photoURL}">
                <span class="text-sm font-medium">${usr.displayName}</span>
            `;
            container.appendChild(div);
        });
    }

    async createGroup() {
        const name = document.getElementById('input-group-name').value.trim();
        if (name === "") {
            this.showToast("Please specify group subject.", "error");
            return;
        }

        const selectedMembers = Array.from(document.querySelectorAll('.group-select-checkbox:checked')).map(el => el.value);
        selectedMembers.push(this.currentUser.uid);

        const groupPayload = {
            name: name,
            createdBy: this.currentUser.uid,
            admins: [this.currentUser.uid],
            members: selectedMembers,
            createdAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(this.db, "groups"), groupPayload);
        this.toggleGroupModal(false);
        this.showToast(`Group "${name}" established!`);
    }

    async openGroupChat(group) {
        if (this.activeMessagesListener) this.activeMessagesListener();

        this.activeChatType = 'group';
        this.activeGroupData = group;
        this.activeChatId = group.id || group.uid;

        document.getElementById('chat-idle-state').classList.add('hidden');
        document.getElementById('chat-active-state').classList.remove('hidden');

        document.getElementById('active-target-avatar').src = `https://api.dicebear.com/7.x/initials/svg?seed=${group.name}`;
        document.getElementById('active-target-name').textContent = group.name;
        document.getElementById('active-target-status').textContent = `${group.members.length} active members`;

        this.listenForMessages();
        this.listenForTyping(this.activeChatId);
        
        this.enterActiveChatMobile();
    }

    // =========================================================================
    // STORY SYSTEM (24-Hour Expiration & Expiry Logic)
    // =========================================================================
    async postStory(file) {
        if (!file) return;
        this.showToast("Publishing story upload...");
        try {
            const url = await this.uploadToR2(file);
            await addDoc(collection(this.db, "stories"), {
                userId: this.currentUser.uid,
                userName: this.currentUser.displayName,
                userPhoto: this.currentUser.photoURL,
                mediaUrl: url,
                mediaType: file.type.startsWith('video/') ? 'video' : 'image',
                timestamp: serverTimestamp(),
                views: [],
                reactions: {}
            });
            this.showToast("Story Published Successfully!");
        } catch (error) {
            this.showToast("Story upload failed.", "error");
        }
    }

    listenForStories() {
        const tray = document.getElementById('stories-tray');
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const q = query(collection(this.db, "stories"), where("timestamp", ">=", twentyFourHoursAgo));
        
        onSnapshot(q, (snapshot) => {
            const myStoryWidget = document.getElementById('btn-add-story');
            tray.innerHTML = "";
            tray.appendChild(myStoryWidget);

            snapshot.forEach(docSnap => {
                const story = docSnap.data();
                story.id = docSnap.id;
                
                const div = document.createElement('div');
                div.className = "flex flex-col items-center gap-1.5 cursor-pointer transition-transform hover:scale-105 flex-shrink-0";
                div.innerHTML = `
                    <div class="w-16 h-16 rounded-2xl border-2 border-brand-500 p-0.5 shadow-neon-brand">
                        <img class="w-full h-full rounded-2xl object-cover" src="${story.userPhoto}">
                    </div>
                    <span class="text-[11px] font-bold text-slate-500 max-w-[60px] truncate text-center">${story.userName}</span>
                `;
                div.addEventListener('click', () => this.openStoryViewer(story));
                tray.appendChild(div);
            });
        });
    }

    async openStoryViewer(story) {
        this.activeStory = story;
        this.toggleElementDisplay('story-viewer-modal', true);

        document.getElementById('story-author-avatar').src = story.userPhoto;
        document.getElementById('story-author-name').textContent = story.userName;
        document.getElementById('story-time').textContent = story.timestamp ? new Date(story.timestamp.toDate()).toLocaleTimeString() : "";

        const img = document.getElementById('story-media-image');
        const video = document.getElementById('story-media-video');
        
        const safeStoryUrl = this.ensureAbsoluteUrl(story.mediaUrl);

        if (story.mediaType === 'video') {
            img.classList.add('hidden');
            video.classList.remove('hidden');
            video.src = safeStoryUrl;
        } else {
            video.classList.add('hidden');
            video.src = "";
            img.classList.remove('hidden');
            img.src = safeStoryUrl;
        }

        if (story.userId === this.currentUser.uid) {
            document.getElementById('story-viewer-list-panel').classList.remove('hidden');
            document.getElementById('story-viewers-count').textContent = `${story.views.length} views`;
        } else {
            document.getElementById('story-viewer-list-panel').classList.add('hidden');
            await updateDoc(doc(this.db, "stories", story.id), {
                views: arrayUnion(this.currentUser.uid)
            });
        }

        document.querySelectorAll('.story-react-btn').forEach(btn => {
            btn.onclick = async () => {
                const reactionStr = btn.textContent;
                await updateDoc(doc(this.db, "stories", story.id), {
                    [`reactions.${this.currentUser.uid}`]: reactionStr
                });
                this.showToast(`Reacted with ${reactionStr}`);
            };
        });
    }

    async sendStoryReply() {
        const text = document.getElementById('input-story-reply').value.trim();
        if (text === "") return;

        const generatedChatId = [this.currentUser.uid, this.activeStory.userId].sort().join('_');
        await addDoc(collection(this.db, "messages"), {
            chatId: generatedChatId,
            senderId: this.currentUser.uid,
            senderName: this.currentUser.displayName,
            text: `[Replied to Story]: ${text}`,
            timestamp: serverTimestamp()
        });

        document.getElementById('input-story-reply').value = "";
        this.toggleElementDisplay('story-viewer-modal', false);
        this.showToast("Reply sent via private chat.");
    }

    // =========================================================================
    // AUDIO / VIDEO CALLING LOGIC (LEGENDARY NATIVE SYSTEM SETUP)
    // =========================================================================
    async initiateCall(callType) {
        if (!CONFIG.zegocloud.appID || !CONFIG.zegocloud.serverSecret) {
            this.showToast("ZEGOCLOUD configuration parameters missing.", "error");
            return;
        }

        const callRoomId = this.activeChatId;
        const targetUser = this.activeTargetUser;

        document.getElementById('caller-avatar').src = targetUser.photoURL;
        document.getElementById('caller-name').textContent = targetUser.displayName;
        document.getElementById('call-status-label').textContent = `Outgoing ${callType} connection...`;
        
        document.getElementById('btn-call-accept').classList.add('hidden');
        document.getElementById('btn-call-decline').classList.remove('hidden');
        
        this.toggleElementDisplay('native-calling-overlay', true);

        const callDocRef = await addDoc(collection(this.db, "calls"), {
            roomId: callRoomId,
            initiatorId: this.currentUser.uid,
            initiatorName: this.currentUser.displayName,
            initiatorPhoto: this.currentUser.photoURL,
            targetId: targetUser.uid,
            type: callType,
            status: "ringing",
            timestamp: serverTimestamp()
        });

        this.activeCallSessionId = callDocRef.id;

        const callListener = onSnapshot(callDocRef, (snap) => {
            if (!snap.exists()) return;
            const call = snap.data();
            
            if (call.status === 'accepted') {
                callListener();
                this.toggleElementDisplay('native-calling-overlay', false);
                this.joinZegoCallRoom(callRoomId, callType);
            } else if (call.status === 'declined') {
                callListener();
                this.toggleElementDisplay('native-calling-overlay', false);
                this.showToast("Call declined.", "error");
            }
        });

        document.getElementById('btn-call-decline').onclick = async () => {
            await updateDoc(callDocRef, { status: "cancelled" });
            callListener();
            this.toggleElementDisplay('native-calling-overlay', false);
        };
    }

    listenForIncomingCalls() {
        if (!this.currentUser) return;
        const q = query(
            collection(this.db, "calls"), 
            where("targetId", "==", this.currentUser.uid), 
            where("status", "==", "ringing"),
            limit(1)
        );

        onSnapshot(q, (snapshot) => {
            if (snapshot.empty) return;
            const activeCall = snapshot.docs[0].data();
            activeCall.id = snapshot.docs[0].id;
            this.activeCallSessionId = activeCall.id;

            document.getElementById('caller-avatar').src = activeCall.initiatorPhoto || `https://api.dicebear.com/7.x/initials/svg?seed=${activeCall.initiatorName}`;
            document.getElementById('caller-name').textContent = activeCall.initiatorName;
            document.getElementById('call-status-label').textContent = `Incoming ${activeCall.type} connection...`;
            
            document.getElementById('btn-call-accept').classList.remove('hidden');
            document.getElementById('btn-call-decline').classList.remove('hidden');
            
            this.toggleElementDisplay('native-calling-overlay', true);

            document.getElementById('btn-call-accept').onclick = async () => {
                await updateDoc(doc(this.db, "calls", activeCall.id), { status: "accepted" });
                this.toggleElementDisplay('native-calling-overlay', false);
                this.joinZegoCallRoom(activeCall.roomId, activeCall.type);
            };

            document.getElementById('btn-call-decline').onclick = async () => {
                await updateDoc(doc(this.db, "calls", activeCall.id), { status: "declined" });
                this.toggleElementDisplay('native-calling-overlay', false);
            };
        });
    }

    joinZegoCallRoom(roomId, callType) {
        this.toggleElementDisplay('zego-call-container', true);

        setTimeout(() => {
            try {
                const appID = Number(CONFIG.zegocloud.appID);
                const serverSecret = CONFIG.zegocloud.serverSecret;
                
                const kitToken = ZegoUIKitPrebuilt.generateKitTokenForTest(
                    appID, 
                    serverSecret, 
                    roomId, 
                    this.currentUser.uid, 
                    this.currentUser.displayName
                );

                this.zegoInstance = ZegoUIKitPrebuilt.create(kitToken);
                this.zegoInstance.joinRoom({
                    container: document.getElementById('zego-call-render'),
                    sharedLinks: [{
                        name: 'Join Call Direct Link',
                        url: window.location.origin + '?roomID=' + roomId + '&type=' + callType,
                    }],
                    scenario: {
                        mode: this.activeChatType === 'private' ? ZegoUIKitPrebuilt.OneONoneCall : ZegoUIKitPrebuilt.GroupCall,
                    },
                    showPreJoinView: false, 
                    showScreenSharingButton: true, 
                    showMyCameraToggleButton: true, 
                    showMyMicrophoneToggleButton: true, 
                    showAudioVideoSettingsButton: true, 
                    showUserList: true, 
                    showTextChatInRoom: false, 
                    showLayoutButton: true, 
                    showNonVideoUser: true,
                    useFrontCamera: true,
                    turnOnCameraWhenJoining: callType === 'video',
                    turnOnMicrophoneWhenJoining: true,
                    onLeaveRoom: () => this.terminateZegoCall()
                });
            } catch (error) {
                this.showToast("Could not mount media stream device.", "error");
                console.error("ZEGOCLOUD initialization failed:", error);
            }
        }, 150);
    }

    async terminateZegoCall() {
        if (this.zegoInstance) {
            this.zegoInstance.destroy();
            this.zegoInstance = null;
        }
        if (this.activeCallSessionId) {
            await updateDoc(doc(this.db, "calls", this.activeCallSessionId), { status: "ended" });
        }
        this.toggleElementDisplay('zego-call-container', false);
        this.showToast("Call Session Ended.");
    }

    // =========================================================================
    // FOREGROUND / BACKGROUND PUSH NOTIFICATIONS (FCM)
    // =========================================================================
    async registerPushNotifications() {
        try {
            const messaging = getMessaging(this.firebaseApp);
            const token = await getToken(messaging, { vapidKey: 'YOUR_PUBLIC_FCM_VAPID_KEY' });
            if (token) {
                await updateDoc(doc(this.db, "users", this.currentUser.uid), {
                    fcmToken: token
                });
            }

            onMessage(messaging, (payload) => {
                this.showToast(`${payload.notification.title}: ${payload.notification.body}`);
            });
        } catch (error) {
            console.log("FCM Setup bypassed - VAPID Key unconfigured.");
        }
    }

    // =========================================================================
    // ANALYTICAL METRICS DETAILS DRAWER
    // =========================================================================
    async loadDrawerDetails() {
        const isStarredContainer = document.getElementById('drawer-tab-container');
        isStarredContainer.innerHTML = "";

        if (this.activeChatType === 'private') {
            document.getElementById('drawer-user-avatar').src = this.activeTargetUser.photoURL;
            document.getElementById('drawer-user-name').textContent = this.activeTargetUser.displayName;
            document.getElementById('drawer-user-bio').textContent = this.activeTargetUser.bio || "No status bio updated.";
            
            const q = query(
                collection(this.db, "messages"), 
                where("chatId", "==", this.activeChatId), 
                where("isStarredBy", "array-contains", this.currentUser.uid)
            );
            const snapshots = await getDocs(q);
            if (snapshots.empty) {
                isStarredContainer.innerHTML = `<span class="text-xs text-slate-400">No starred items.</span>`;
                return;
            }
            snapshots.forEach(docSnap => {
                const msg = docSnap.data();
                const div = document.createElement('div');
                div.className = "p-2 rounded-lg bg-slate-100 dark:bg-slate-850 text-xs";
                div.innerHTML = `<strong>${msg.senderName}:</strong> <p>${msg.text || "Attachment File"}</p>`;
                isStarredContainer.appendChild(div);
            });
        }
    }

    // =========================================================================
    // ADMIN CONSOLE CORE CONTROL FLOWS
    // =========================================================================
    async openAdminDashboard() {
        this.toggleElementDisplay('admin-dashboard-modal', true);

        const usersSnap = await getDocs(collection(this.db, "users"));
        const groupsSnap = await getDocs(collection(this.db, "groups"));
        const storiesSnap = await getDocs(collection(this.db, "stories"));

        document.getElementById('stat-users-count').textContent = usersSnap.size;
        document.getElementById('stat-groups-count').textContent = groupsSnap.size;
        document.getElementById('stat-stories-count').textContent = storiesSnap.size;

        const tableBody = document.getElementById('admin-user-rows');
        tableBody.innerHTML = "";

        usersSnap.forEach(docSnap => {
            const usr = docSnap.data();
            const dateStr = usr.createdAt ? new Date(usr.createdAt.toDate()).toLocaleDateString() : "Prior";
            const isSelf = usr.uid === this.currentUser.uid;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="p-3 flex items-center gap-3">
                    <img class="w-8 h-8 rounded-full" src="${usr.photoURL}">
                    <span class="font-semibold text-slate-800 dark:text-slate-200">${usr.displayName}</span>
                </td>
                <td class="p-3 text-slate-500">${usr.email}</td>
                <td class="p-3 text-slate-500">${dateStr}</td>
                <td class="p-3"><span class="px-2 py-0.5 rounded text-xs ${usr.role === 'admin' ? 'bg-purple-100 dark:bg-purple-950 text-purple-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}">${usr.role}</span></td>
                <td class="p-3 text-right">
                    ${isSelf ? '' : `
                        <button class="ban-toggle-btn px-3 py-1 text-xs rounded-lg font-bold ${usr.banned ? 'bg-green-100 dark:bg-green-950/40 text-green-600' : 'bg-red-100 dark:bg-red-950/40 text-red-600'}" data-uid="${usr.uid}" data-banned="${usr.banned}">
                            ${usr.banned ? "Unban Account" : "Ban Account"}
                        </button>
                    `}
                </td>
            `;

            const btn = tr.querySelector('.ban-toggle-btn');
            if (btn) {
                btn.addEventListener('click', async () => {
                    const targetUid = btn.getAttribute('data-uid');
                    const currentlyBanned = btn.getAttribute('data-banned') === 'true';
                    await updateDoc(doc(this.db, "users", targetUid), {
                        banned: !currentlyBanned
                    });
                    this.showToast("User status updated.");
                    this.openAdminDashboard();
                });
            }
            tableBody.appendChild(tr);
        });
    }
}

const app = new NexusChatApp();
app.run();