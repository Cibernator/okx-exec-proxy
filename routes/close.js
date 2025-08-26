import express from 'express';
export const closeRouter = express.Router();

closeRouter.post('/', async (req, res) => {
  // Aquí lógica para cerrar posición
  res.json({ ok: true, msg: "close endpoint" });
});
