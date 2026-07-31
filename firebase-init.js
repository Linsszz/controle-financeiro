// Inicialização do Firebase — via CDN (ESM), sem bundler, sem etapa de build.
//
// Só usa Firestore como banco de dados. O único uso do Code.gs neste
// projeto é como proxy de segredos da integração de Open Finance (Pluggy,
// aba "Conexões Bancárias") — veja PLUGGY_PROXY_URL logo abaixo e o
// README, seção "Conexões Bancárias".
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

// URL "/exec" do Code.gs implantado (proxy de segredos da Pluggy). TROQUE
// pela URL "/exec" que você copiar ao implantar o Code.gs (veja o README,
// seção "Conexões Bancárias"). Enquanto ficar com o valor de exemplo, a aba
// "Conexões Bancárias" mostra um aviso pra configurar em vez de tentar
// conectar — o resto do sistema funciona normalmente sem isso.
export const PLUGGY_PROXY_URL = "https://script.google.com/macros/s/AKfycbzSG3yHjiaF0DWGpYWkymzjaETAvP6wQ5EKFWsJKm-EJxSZ_d0zfflDlXPflQ9XuKiA/exec";
