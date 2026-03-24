import { Router } from "express";
import {
  getSessionStatus,
  runScreening,
  startDiscovery,
  triggerDockingValidation,
  discoverMolecules
} from "../controllers/discoveryController.js";

const router = Router();

router.post("/sessions", startDiscovery);
router.get("/sessions/:sessionId/status", getSessionStatus);
router.post("/sessions/:sessionId/screen", runScreening);
router.post("/sessions/:sessionId/validate", triggerDockingValidation);
router.post("/discover", discoverMolecules);

export default router;
