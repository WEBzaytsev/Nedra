import { Navigate, useLocation } from "react-router-dom";

import LoginPage from "./pages/LoginPage";
import PasswordsPage from "./pages/PasswordsPage";
import UsersPage from "./pages/UsersPage";
import EntryCreatePage from "./pages/EntryCreatePage";
import PreferencesPage from "./pages/PreferencesPage";
import { getCurrentUser, isAuth } from "./utils";

const ProtectedRoute = ({ children, role }) => {
  const location = useLocation();
  if (!isAuth()) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ returnTo: location.pathname + location.search + location.hash }}
      />
    );
  }
  if (role && getCurrentUser()?.role !== role) return <Navigate to="/passwords" replace />;
  return children;
};

const routes = [
  ...[
    { path: "/settings", section: "settings", role: "admin" },
    { path: "/account/password", section: "password" },
    { path: "/updates", section: "updates" },
  ].map(({ path, section, role }) => ({
    path,
    element: (
      <ProtectedRoute role={role}>
        <PreferencesPage section={section} />
      </ProtectedRoute>
    ),
  })),
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/passwords",
    element: (
      <ProtectedRoute>
        <PasswordsPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/entries/new",
    element: (
      <ProtectedRoute>
        <EntryCreatePage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/users",
    element: (
      <ProtectedRoute role="admin">
        <UsersPage />
      </ProtectedRoute>
    ),
  },
];

export default routes;
