import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import router from "./routes";
import authRouter from "./routes/auth";
import { logger } from "./lib/logger";
import { requireAuth } from "./lib/auth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, res, next): void => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) {
    next();
    return;
  }
  const expectedHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  try {
    if (new URL(req.headers.origin).host !== expectedHost) {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Invalid request origin" });
    return;
  }
  next();
});
app.use("/api/auth", authRouter);

const requireApiAuth: RequestHandler = (req, res, next): void => {
  if (req.path === "/healthz") {
    next();
    return;
  }
  requireAuth(req, res, next);
};

app.use("/api", requireApiAuth, router);

export default app;
