import { Router, type IRouter } from "express";
import healthRouter from "./health";
import crmRouter from "./crm";
import consultationAiRouter from "./consultation-ai";
import { startDatabaseBackupScheduler } from "../lib/database-backup";
import contractsRouter from "./contracts";
import loanApplicationsRouter from "./loan-applications";

const router: IRouter = Router();
startDatabaseBackupScheduler();

router.use(healthRouter);
router.use(crmRouter);
router.use(consultationAiRouter);
router.use(contractsRouter);
router.use(loanApplicationsRouter);

export default router;
