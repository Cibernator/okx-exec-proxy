import express from 'express';
export const amendTPSLRouter = express.Router();

amendTPSLRouter.post('/', async (req, res) => {
  // Aquí lógica para modificar TP/SL
  res.json({ ok: true, msg: "amend-tpsl endpoint" });
});
