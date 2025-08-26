import express from 'express';
export const positionsRouter = express.Router();

positionsRouter.post('/', async (req, res) => {
  // Aquí lógica para consultar posiciones a OKX
  res.json({ ok: true, msg: "positions endpoint" });
});
