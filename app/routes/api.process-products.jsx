// app/routes/api.process-products.jsx
import { syncXmlString } from "../services/xml-sync.server.js";
import { authenticate } from "../shopify.server.js";

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { xmlString } = await request.json();

    if (!xmlString) {
      return Response.json({ success: false, error: "xmlString requerido" }, { status: 400 });
    }

    // Lanzamos la sincronización SIN esperar a que termine
    // porque el frontend recibirá todos los eventos por SSE
    syncXmlString(admin, xmlString)
      .then((result) => {
        console.log("✔️ Sincronización finalizada", result);
      })
      .catch((err) => {
        console.error("❌ Error en syncXmlString:", err);
      });

    return Response.json({
      success: true,
      message: "Procesamiento iniciado",
    });

  } catch (error) {
    console.error("❌ /api/process-products", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};
