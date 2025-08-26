import express from 'express';
export const balanceRouter = express.Router();

balanceRouter.get('/', async (req, res) => {
  // Aquí lógica para consultar balance
  res.json({ ok: true, msg: "balance endpoint" });
});
