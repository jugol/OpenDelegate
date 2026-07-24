import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AdminApplication } from "./AdminApplication";
import { AdminI18nProvider, initializeDocumentLocale } from "./i18n";
import "./styles.css";

const initialLocale = initializeDocumentLocale();
const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("OpenDelegate Admin Web root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <AdminI18nProvider initialLocale={initialLocale}>
      <AdminApplication />
    </AdminI18nProvider>
  </StrictMode>,
);
