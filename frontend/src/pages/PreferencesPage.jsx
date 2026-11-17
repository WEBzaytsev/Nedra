import { useLocation, useNavigate } from "react-router-dom";
import SettingsModal from "../components/SettingsModal";
import PasswordChangeDialog from "../components/PasswordChangeDialog";
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
  return <UpdateDialog open onClose={close} />;
}
