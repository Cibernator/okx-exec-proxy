import express from 'express';
export const orderRouter = express.Router();

orderRouter.post('/', async (req, res) => {
  // Aquí lógica para abrir orden con TP/SL y leverage
  res.json({ ok: true, msg: "order endpoint" });
});
