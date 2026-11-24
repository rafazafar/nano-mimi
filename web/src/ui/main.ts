import "./styles/index.css";
import { mountApp } from "./app";
import { realDeps } from "./realDeps";

const root = document.getElementById("app");
if (root === null) throw new Error("#app missing from index.html");
mountApp(root, realDeps());
