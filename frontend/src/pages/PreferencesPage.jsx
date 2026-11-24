import { useLocation, useNavigate } from "react-router-dom";
import SettingsModal from "../components/SettingsModal";
import PasswordChangeDialog from "../components/PasswordChangeDialog";
import SecurityKeyDialog from "../components/SecurityKeyDialog";
import RecoveryCodeDialog from "../components/RecoveryCodeDialog";
import UpdateDialog from "../components/UpdateDialog";

export default function PreferencesPage({ section }) {
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => {
    if (location.state?.taskReturn) navigate(-1);
    else navigate("/passwords", { replace: true });
  };
  if (section === "settings") return <SettingsModal open onClose={close} />;
  if (section === "password") return <PasswordChangeDialog open onClose={close} />;
  if (section === "security-key") return <SecurityKeyDialog open onClose={close} />;
  if (section === "recovery") return <RecoveryCodeDialog open onClose={close} />;
  return <UpdateDialog open onClose={close} />;
}
