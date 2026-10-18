import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  updateProfile
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBAXI_TZzEycochNymgQlMRnTy95Me4MyU",
  authDomain: "controle-de-agua-cdf84.firebaseapp.com",
  projectId: "controle-de-agua-cdf84",
  storageBucket: "controle-de-agua-cdf84.firebasestorage.app",
  messagingSenderId: "1061338435751",
  appId: "1:1061338435751:web:53d49460b03f02d7adcb82"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const authApi = {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile
};
export { doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, serverTimestamp };

export const RESIDENCE_ID = "casa-principal";
const residenceRef = doc(db, "residencias", RESIDENCE_ID);
const configRef = doc(db, "residencias", RESIDENCE_ID, "configuracao", "principal");

export function watchResidence(onData, onError, onReady) {
  let configLoaded = false;
  const loaded = new Set();
  const result = { config: null, supplies: [], transfers: [], measurements: [], audit: [] };
  let stopped = false;
  const unsubscribers = [];
  const finish = () => {
    if (!stopped && configLoaded && ["abastecimentos","transferencias","medicoes","auditoria"].every(x=>loaded.has(x))) {
      onData(result);
      onReady?.(result.config === null);
    }
  };
  unsubscribers.push(onSnapshot(configRef, snap => {
    result.config = snap.exists() ? snap.data() : null;
    configLoaded = true; finish();
  }, onError));
  const collections = [
    ["abastecimentos","supplies"],["transferencias","transfers"],
    ["medicoes","measurements"],["auditoria","audit"]
  ];
  for (const [path,key] of collections) {
    unsubscribers.push(onSnapshot(collection(db,"residencias",RESIDENCE_ID,path), snap => {
      result[key] = snap.docs.map(d => ({...d.data(), id:d.id}));
      loaded.add(path); finish();
    }, onError));
  }
  return () => { stopped=true; unsubscribers.forEach(fn=>fn()); };
}

export async function writeResidenceRecord(collectionName, record) {
  const allowed = {
    supplies: "abastecimentos",
    transfers: "transferencias",
    measurements: "medicoes",
    audit: "auditoria"
  };
  const path = allowed[collectionName];
  if (!path) throw new Error("Tipo de registro não permitido para gravação.");
  if (!auth.currentUser) throw new Error("Você precisa entrar na sua conta.");
  const clean = { ...record, id: record.id, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid };
  await setDoc(doc(db, "residencias", RESIDENCE_ID, path, record.id), clean, { merge: true });
}

export async function saveResidenceConfiguration(residence) {
  if (!auth.currentUser) throw new Error("Você precisa entrar na sua conta.");
  await setDoc(configRef, {
    name: residence.name,
    capacityLiters: residence.capacityLiters,
    alertLiters: residence.alertLiters,
    referencePriceCents: residence.referencePriceCents,
    initialSetupDone: !!residence.initialSetupDone,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser.uid
  }, { merge: true });
}

export async function syncResidenceState(state) {
  const cfg = {
    name: state.residence.name,
    capacityLiters: state.residence.capacityLiters,
    alertLiters: state.residence.alertLiters,
    referencePriceCents: state.residence.referencePriceCents,
    initialSetupDone: !!state.residence.initialSetupDone,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.uid || null
  };
  await setDoc(configRef, cfg, {merge:true});
  const jobs = [];
  const groups = [
    ["abastecimentos", state.supplies || []],
    ["transferencias", state.transfers || []],
    ["medicoes", state.measurements || []],
    ["auditoria", state.audit || []]
  ];
  for (const [path,records] of groups) {
    for (const record of records) {
      const clean = {...record};
      delete clean.id;
      jobs.push(setDoc(doc(db,"residencias",RESIDENCE_ID,path,record.id), {
        ...clean,
        id: record.id,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || null
      }, {merge:true}));
    }
  }
  await Promise.all(jobs);
}


// Exclui os registros compartilhados da residência, sem remover contas de membros.
export async function deleteResidenceRecords() {
  const paths = ["abastecimentos", "transferencias", "medicoes", "auditoria"];
  for (const path of paths) {
    const snap = await getDocs(collection(db, "residencias", RESIDENCE_ID, path));
    // Excluir em lotes pequenos evita excesso de operações simultâneas no cliente.
    for (let i = 0; i < snap.docs.length; i += 400) {
      await Promise.all(snap.docs.slice(i, i + 400).map(item => deleteDoc(item.ref)));
    }
  }
  await setDoc(configRef, {
    name: "Minha residência", capacityLiters: 5000, alertLiters: 1000,
    referencePriceCents: 25000, initialSetupDone: false,
    updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.uid || null
  });
}
