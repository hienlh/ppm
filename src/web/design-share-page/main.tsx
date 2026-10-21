import { createRoot } from "react-dom/client";
import "./share.css";
import { ShareApp } from "./share-app";

/**
 * Entry of the reviewer's page at `/s/<code>`. Deliberately none of the app's start-up: no
 * service worker, no stores, no PPM token, no trace client. Everything this page knows comes
 * from `/s/<code>/…`.
 */
const root = document.getElementById("root");
if (root) createRoot(root).render(<ShareApp />);
