import { createRoot } from "react-dom/client";
import { App } from "./App";
import { client } from "./client";
import "@fontsource/press-start-2p";
import "@fontsource/vt323";
import "./styles.css";

client.start();
createRoot(document.getElementById("root")!).render(<App />);
