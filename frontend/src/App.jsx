import { Navigate, Route, Routes } from "react-router-dom";
import DiscoveryDashboard from "./pages/DiscoveryDashboard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DiscoveryDashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
