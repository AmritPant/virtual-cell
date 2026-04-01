import { Router } from "express";
import { discoverMolecules } from "../controllers/discoveryController.js";

const router = Router();

router.post("/discover", discoverMolecules);

export default router;
