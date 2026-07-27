// Inicialização do Firebase — via CDN (ESM), sem bundler, sem etapa de build.
//
// Só usa Firestore. Este sistema não guarda fotos/arquivos, então não há
// Code.gs neste projeto (se um dia precisar de upload de comprovantes, veja
// a skill felipe-firebase-style para adicionar isso via Google Drive).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// TROQUE pela config do SEU projeto (Firebase Console > Configurações do
// projeto > seus apps > app Web > "Config"). Essas chaves são públicas por
// design no Firebase Web — a segurança vem das regras (firestore.rules),
// não de esconder essa config.
const firebaseConfig = {
  apiKey: "AIzaSyBL4ASlxCVVdi-pPR3FVQL1HgVa5JNxrAg",
  authDomain: "financeiroleonardo.firebaseapp.com",
  projectId: "financeiroleonardo",
  storageBucket: "financeiroleonardo.firebasestorage.app",
  messagingSenderId: "872457401759",
  appId: "1:872457401759:web:80138b7ad5b5fa1cdf79aa"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);

// Por padrão, sempre conecta no projeto Firestore REAL (mesmo testando
// local ou pela hospedagem) — assim dá pra testar sem precisar rodar nenhum
// emulador. Só usa o emulador local se a página abrir com "?emulator=1" na
// URL (ex: http://localhost:8000/?emulator=1).
if (new URLSearchParams(location.search).has("emulator")) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.log("[firebase] usando emulador local do Firestore (:8080)");
}
