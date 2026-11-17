import ReactDOM from "react-dom/client";
import { StoreProvider } from "easy-peasy";
import { settings as dateSettings } from "@gravity-ui/date-utils";
import { ToasterProvider } from "@gravity-ui/uikit";
import { toaster } from "@gravity-ui/uikit/toaster-singleton";
import "@gravity-ui/uikit/styles/styles.css";
import "./styles/nedra-theme.css";
import "./i18n";

import App from "./App";
import { store } from "./store";
import { forgetLegacyKey } from "./utils";

forgetLegacyKey();
dateSettings.setDefaultTimeZone("system");

const root = ReactDOM.createRoot(document.getElementById("root"));

const render = () => {
  root.render(
    <StoreProvider store={store}>
      <ToasterProvider toaster={toaster}>
        <App />
      </ToasterProvider>
    </StoreProvider>
  );

  if (import.meta.env.VITE_DESKTOP_QA === "1") {
    if (import.meta.env.VITE_UPDATE_QA === "1") import("./platform/qaUpdates");
    else import("./platform/qa");
  }
};

Promise.allSettled([dateSettings.loadLocale("en"), dateSettings.loadLocale("ru")]).then(render);
