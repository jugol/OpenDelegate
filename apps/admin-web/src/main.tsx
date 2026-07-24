import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AdminApplication } from "./AdminApplication";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("OpenDelegate Admin Web root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <AdminApplication />
  </StrictMode>,
);
