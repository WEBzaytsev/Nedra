import { createContext } from "react";

// Volatile view state only: scoped to the authenticated shell, cleared on logout.
export const VaultViewContext = createContext(null);
