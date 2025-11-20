import { ProgressBar } from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';
import React, { useEffect, useState } from 'react';
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.js";
import styles from "./_index/styles.module.css";

// CSS inline para animaciones
const animationStyles = `
  @keyframes fadeInSlide {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`;

export const action = async ({ request }) => {
  console.warn('🚨 [ACTION] Action ejecutado - Método:', request.method);

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { session, admin } = await authenticate.admin(request);
    console.info('✅ [ACTION] Autenticación exitosa');

    const formData = await request.formData();
    const xmlUrl = formData.get("xmlUrl");

    if (!xmlUrl) {
      return Response.json({ error: "URL del XML es requerida" }, { status: 400 });
    }

    // Usar parseXMLData para obtener estadísticas de variantes y estructuración completa
    const { syncXmlString } = await import("../services/xml-sync.server.js");

    // Solo parsear (sin admin = solo parsing y estadísticas, no creación en Shopify)
    const parsedProducts = await syncXmlString(admin, xmlUrl);

    if (!parsedProducts || parsedProducts.length === 0) {
      return Response.json({ error: "No se encontraron productos en el XML" }, { status: 400 });
    }

    console.error(`📦 [ACTION] Parseados ${parsedProducts.length} productos con variantes - enviando al cliente`);

    const shopDomain = session.shop.replace('.myshopify.com', '');

    // Devolver productos parseados al cliente
    return Response.json({
      success: true,
      totalProducts: parsedProducts.length,
      products: parsedProducts, // ← Los productos van al cliente
      message: 'XML parseado exitosamente',
      shopDomain,
      parsedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [ACTION] Error:', error);
    return Response.json({
      error: error.message || "Error parseando XML",
      success: false
    }, { status: 500 });
  }
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const shopDomain = session.shop.replace('.myshopify.com', '');

  return Response.json({
    shop: shopDomain,
    sessionId: session.id
  });
};

export default function Index() {
  console.info('🎯 [CLIENT] Renderizando componente');

  const fetcher = useFetcher();
  const loaderData = useLoaderData();
  const [syncState, setSyncState] = useState(null); // Estado unificado

  // Nuevo estado para la tabla de productos
  const [processedProducts, setProcessedProducts] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [productsPerPage] = useState(20);
  const [eventSourceRef, setEventSourceRef] = useState(null);
  // Estado para controlar el desplegable de variantes por producto
  const [openVariantProductId, setOpenVariantProductId] = useState(null);
  // Nuevo estado para el acordeón de grupos
  const [openVariantGroupIdx, setOpenVariantGroupIdx] = useState(null);
  const [grupos, setGrupos] = useState([]);

  // Función para limpiar todo el estado de importación
  const resetImportState = async () => {
    setProcessedProducts([]);
    setCurrentPage(1);
    setSyncState((prev) => ({
      ...prev,
      isActive: false,
      status: "cancelled",
      currentStep: "Importación cancelada por el usuario"
    }));
    if (eventSourceRef) {
      eventSourceRef.close?.();
    }
    try {
      await fetch("/api/sync-cancel");
    } catch (e) {
      console.warn("No se pudo notificar la cancelación al backend", e);
    }
  };

  // Cálculo de paginación
  const totalPages = Math.ceil((processedProducts?.length || 0) / productsPerPage);
  const startIndex = (currentPage - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const currentProducts = (processedProducts || []).slice(startIndex, endIndex);

  const actionData = fetcher.data;
  const isLoading = fetcher.state === "submitting";

  const PROCESSED_TYPE = {
    'created': 'Creado',
    'updated': 'Actualizado',
    'skipped': 'Omitido',
    'error': 'Error',
    'product_error': 'Error'
  }

  useEffect(() => {
    const es = new EventSource("/api/sync-events");

    setSyncState({
      isActive: true,
      status: "stopped",
      totalItems: 0,
      processedItems: 0,
      createdItems: 0,
      updatedItems: 0,
      skippedItems: 0,
      errorItems: 0,
      recentProducts: [],
      currentStep: "Esperando eventos…"
    });

    es.addEventListener("connected", () => {
      setSyncState(prev => ({
        ...prev,
        currentStep: "Conectado al servidor"
      }));
    });

    es.addEventListener("sync-start", e => {
      const d = JSON.parse(e.data);

      setSyncState(prev => ({
        ...prev,
        status: "syncing",
        totalItems: d.totalProducts || 0,
        currentStep: "Sincronización iniciada"
      }));
    });

    es.addEventListener("groups-detected", e => {
      const d = JSON.parse(e.data);

      console.log(d.groups);
      setSyncState(prev => ({
        ...prev,
        currentStep: `Detectados ${Object.keys(d.groups).length} grupos`
      }));
    });

    es.addEventListener("group-start", e => {
      const d = JSON.parse(e.data);
      setSyncState(prev => ({ ...prev, currentStep: `Iniciando grupo ${d.groupId}` }));
    });

    es.addEventListener("processing-group", e => {
      const d = JSON.parse(e.data);

      setSyncState(prev => ({
        ...prev,
        currentStep: `Procesando grupo ${d.groupId}`
      }));
    });

    es.addEventListener("group-created", e => {
      const d = JSON.parse(e.data);

      setSyncState(prev => ({
        ...prev,
        currentStep: `Creando producto: ${d.title}`,
        recentProducts: [
          { type: "request", title: d.title, groupId: d.groupId },
          ...((prev.recentProducts || []).slice(0, 9))
        ]
      }));
    });

    es.addEventListener("product-create-request", e => {
      const d = JSON.parse(e.data);

      // extraer título/sku si vienen en result.product
      const title = d.result?.product?.title || d.result?.product?.id || d.groupId;
      const sku = d.result?.product?.variants?.[0]?.sku || null;

      setSyncState(prev => ({
        ...prev,
        createdItems: (prev.createdItems || 0) + 1,
        processedItems: (prev.processedItems || 0) + 1,
        currentStep: `Producto creado: ${title}`,
        recentProducts: [
          { type: "created", title, sku },
          ...((prev.recentProducts || []).slice(0, 9))
        ]
      }));
    });

    es.addEventListener("group-updated", e => {
      const d = JSON.parse(e.data);
      const createdInGroup = d.result?.created || 0;
      const updatedInGroup = d.result?.updated || 0;

      setSyncState(prev => ({
        ...prev,
        // contamos el "grupo" como 1 processed (representa el producto principal)
        processedItems: (prev.processedItems || 0) + 1,
        // las variantes creadas/actualizadas acumuladas
        createdItems: (prev.createdItems || 0) + createdInGroup,
        updatedItems: (prev.updatedItems || 0) + updatedInGroup,
        currentStep: `Grupo actualizado: ${d.groupId} (+${createdInGroup} / ~${updatedInGroup})`,
        recentProducts: [
          { type: "updated", title: d.groupId, created: createdInGroup, updated: updatedInGroup },
          ...((prev.recentProducts || []).slice(0, 9))
        ]
      }));
    });

    es.addEventListener("sync-end", e => {
      console.log("Fin de sync:", JSON.parse(e.data));
      es.close();
    });

    return () => es.close();
  }, []);

  // ✨ NUEVO: useEffect que inicia procesamiento cuando recibimos productos del action
  useEffect(() => {
    if (!actionData?.success || !actionData?.products) return;

    const startTime = performance.now();
    console.warn(`🎯 [CLIENT] ${Date.now()} - Productos recibidos del action, iniciando procesamiento...`);
    console.warn('🎯 [CLIENT] Productos:', actionData.products.length, 'Shop:', actionData.shopDomain);

    // Llamar al endpoint de procesamiento
    const startProcessing = async () => {
      try {
        console.warn(`📤 [CLIENT] ${Date.now()} - Enviando productos para procesamiento...`);

        const response = await fetch('/api/process-products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            products: actionData.products,
            shopDomain: actionData.shopDomain
          })
        });

        const result = await response.json();
        const endTime = performance.now();

        if (result.success) {
          console.warn(`✅ [CLIENT] ${Date.now()} - Procesamiento iniciado exitosamente (${Math.round(endTime - startTime)}ms)`);
          console.warn('🔄 [CLIENT] Esperando eventos SSE...');
          setGrupos(result.grupos || []);
        } else {
          console.error('❌ [CLIENT] Error iniciando procesamiento:', result.error);
        }

      } catch (error) {
        console.error('❌ [CLIENT] Error llamando procesamiento:', error);
      }
    };

    startProcessing();

  }, [actionData]); // ← Se ejecuta cuando actionData cambia


  return (
    <div className={styles.xmlApp}>
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      <s-page heading="Importar Productos desde XML" inlineSize='large'>

        {/* SECCIÓN PRINCIPAL DE IMPORTACIÓN */}
        <s-section>
          <s-card>
            <s-stack gap="base">
              <s-stack gap="base" horizontal alignment="space-between">
                <s-text variant="heading-md">
                  📦 Importar Productos desde XML
                </s-text>
              </s-stack>

              <s-text variant="body-md" tone="subdued">
                Importa productos desde un feed XML de Google Shopping con procesamiento optimizado en tiempo real.
                ⚡ <strong>Hasta 6 productos simultáneos</strong> con cache inteligente y rate limiting.
              </s-text>

              <fetcher.Form method="post">
                <s-stack gap="base">
                  <s-text-field
                    label="URL del XML"
                    name="xmlUrl"
                    type="url"
                    placeholder="https://ejemplo.com/feed.xml"
                    required
                    details="URL del feed XML con los productos de Google Shopping"
                    disabled={syncState?.status === 'syncing'}
                  />

                  <s-stack direction="inline" columnGap="large">
                    <s-button
                      variant="primary"
                      type="submit"
                      loading={isLoading}
                      disabled={isLoading || syncState?.status === 'syncing'}
                      size="large"
                    >
                      {isLoading ? "🔍 Analizando XML..." :
                        syncState?.status === 'syncing' ? "🚀 Procesando..." :
                          "📥 Importar Productos"}
                    </s-button>
                    <s-button
                      variant="secondary"
                      size="large"
                      onClick={resetImportState}
                      disabled={!syncState?.isActive}
                    >
                      🛑 Cancelar importación
                    </s-button>
                  </s-stack>
                </s-stack>
              </fetcher.Form>
            </s-stack>
          </s-card>
        </s-section>

        {/* SECCIÓN DE PROGRESO EN TIEMPO REAL */}
        {syncState?.isActive && (
          <s-section>
            <s-stack rowGap="large-100">
              <s-stack rowGap="large-100">
                <s-stack direction="inline" columnGap="large">
                  <s-text variant="heading-sm" fontWeight="semibold">
                    🚀 Procesamiento en Tiempo Real
                  </s-text>
                  <s-badge
                    tone={syncState?.status === 'completed' ? 'success' : 'info'}
                    size="small"
                  >
                    {syncState?.status === 'completed' ? '🎉 Completado' : '⚡ En Progreso'}
                  </s-badge>
                </s-stack>

                {/* BARRA DE PROGRESO VISUAL */}
                <s-stack rowGap="large">
                  <ProgressBar
                    progress={((syncState?.processedItems || 0) / (syncState?.totalItems || 1)) * 100}
                    size="small"
                  />
                  <s-stack direction="inline" columnGap="base" blockSize="auto" justifyContent="center">
                    <s-text variant="body-sm" tone="subdued">
                      {syncState?.processedItems || 0} / {syncState?.totalItems || 0} productos individuales
                    </s-text>
                    <s-divider direction="block" />
                    <s-text variant="caption" tone="subdued">
                      {Math.round(((syncState?.processedItems || 0) / (syncState?.totalItems || 1)) * 100)}% completado
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-stack>

              {/* ESTADÍSTICAS EN TIEMPO REAL */}
              <s-stack gap="base" horizontal>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(100px, 1fr))" gap="base">
                  {/* PRODUCTOS NUEVOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text accessibilityRole="" fontWeight="bold" tone="success" >
                        {syncState?.createdItems || 0}
                      </s-text>
                      <s-badge tone="success" size="small">
                        🆕 Nuevos
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* PRODUCTOS ACTUALIZADOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="info">
                        {syncState?.updatedItems || 0}
                      </s-text>
                      <s-badge tone="info" size="small">
                        🔄 Actualizados
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* PRODUCTOS OMITIDOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="warning">
                        {syncState?.skippedItems || 0}
                      </s-text>
                      <s-badge tone="warning" size="small">
                        ⏭️ Omitidos
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* ERRORES */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="critical">
                        {syncState?.errorItems || 0}
                      </s-text>
                      <s-badge tone="critical" size="small">
                        ❌ Errores
                      </s-badge>
                    </s-stack>
                  </s-box>
                </s-grid>

                {/* ESTADO ACTUAL */}
                <s-card>
                  <div style={{
                    padding: '16px',
                    borderLeft: '4px solid #007bff'
                  }}>
                    <s-text variant="body-sm" fontWeight="semibold">
                      📍 Estado Actual:
                    </s-text>
                    <s-text variant="body-sm" tone="subdued">
                      {syncState?.currentStep || 'Preparando...'}
                    </s-text>
                  </div>
                </s-card>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        {/* MENSAJE DE ÉXITO INICIAL */}
        {actionData?.success && !syncState?.isActive && (
          <s-section>
            <s-card>
              <s-banner tone="success">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    ✅ XML parseado exitosamente
                  </s-text>
                  <s-text variant="body-sm">
                    📦 {actionData.totalProducts} productos encontrados
                  </s-text>
                  <s-text variant="body-sm" tone="subdued">
                    ⚡ Iniciando procesamiento...
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        )}

        {/* MENSAJE DE CANCELACIÓN O ERROR */}
        {syncState?.status === "cancelled" ? (
          <s-section>
            <s-card>
              <s-banner tone="warning">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    🛑 Importación cancelada por el usuario
                  </s-text>
                  <s-text variant="body-sm" tone="subdued">
                    Puedes iniciar una nueva importación cuando lo desees.
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        ) : actionData?.error && (
          <s-section>
            <s-card>
              <s-banner tone="critical">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    ❌ Error procesando XML
                  </s-text>
                  <s-text variant="body-sm">
                    {actionData.error}
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        )}

        {/* TABLA DE PRODUCTOS PROCESADOS */}
        {(processedProducts?.length || 0) > 0 && (
          <s-section>
            <s-card>
              <s-stack gap="large">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <s-text variant="heading-md" fontWeight="bold">
                    📦 Productos Procesados ({processedProducts?.length || 0})
                  </s-text>
                  <s-text variant="body-sm" tone="subdued">
                    Página {currentPage} de {totalPages}
                  </s-text>
                </div>

                {/* TABLA DE PRODUCTOS */}
                <s-table>
                  <s-table-header-row>
                    <s-table-header></s-table-header>
                    <s-table-header listSlot="primary">Producto</s-table-header>
                    <s-table-header listSlot="kicker">SKU</s-table-header>
                    <s-table-header listSlot="kicker">Barcode</s-table-header>
                    <s-table-header listSlot="labeled" format="currency">Precio</s-table-header>
                    <s-table-header listSlot="inline">Acción</s-table-header>
                    <s-table-header listSlot="inline">Marca</s-table-header>
                    <s-table-header listSlot="inline">Color</s-table-header>
                    <s-table-header listSlot="inline">Condición</s-table-header>
                    <s-table-header listSlot="inline">Disponibilidad</s-table-header>
                    <s-table-header></s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {(currentProducts || []).map((product) => {
                      const rows = [];
                      rows.push(
                        <s-table-row key={product.id}>
                          {/* Imagen */}
                          <s-table-cell>
                            <s-stack maxInlineSize="130px">
                              <s-thumbnail
                                src={product.imageUrl}
                                alt={product.title}
                                inlineSize="fill"
                              />
                            </s-stack>
                          </s-table-cell>
                          {/* Título */}
                          <s-table-cell>
                            <s-text variant="body-sm" fontWeight="semibold">
                              {product.title}
                            </s-text>
                          </s-table-cell>
                          {/* SKU */}
                          <s-table-cell>
                            <s-text variant="body-sm" tone="subdued">
                              {product.sku || 'N/A'}
                            </s-text>
                          </s-table-cell>
                          {/* Barcode */}
                          <s-table-cell>
                            <s-text variant="body-sm" tone="subdued">
                              {product.barcode || 'N/A'}
                            </s-text>
                          </s-table-cell>
                          {/* Precio */}
                          <s-table-cell>
                            <s-text variant="body-sm" tone="subdued">
                              {Array.isArray(product.variantDetails) && product.variantDetails.length > 0 ? '--' : (product.price || 'N/A')}
                            </s-text>
                          </s-table-cell>
                          {/* Acción */}
                          <s-table-cell>
                            <s-badge
                              tone={
                                product.type === 'created' ? 'success' :
                                  product.type === 'updated' ? 'info' :
                                    product.type === 'product_error' ? 'critical' : 'neutral'
                              }
                            >
                              {product.action}
                            </s-badge>
                          </s-table-cell>
                          {/* Marca */}
                          <s-table-cell>
                            <s-text variant="body-sm" tone="subdued">
                              {product.brand || 'N/A'}
                            </s-text>
                          </s-table-cell>
                          {/* Color */}
                          <s-table-cell>
                            <s-text variant="body-sm" tone="subdued">
                              {product.color || 'N/A'}
                            </s-text>
                          </s-table-cell>
                          {/* Condición */}
                          <s-table-cell>
                            <s-text variant="body-sm">
                              {product.condition}
                            </s-text>
                          </s-table-cell>
                          {/* Disponibilidad */}
                          <s-table-cell>
                            <s-badge tone={product.availability === 'in_stock' ? 'success' : 'warning'}>
                              {product.availability === 'in_stock' ? 'En stock' : 'Agotado'}
                            </s-badge>
                          </s-table-cell>
                          <s-table-cell>
                            {Array.isArray(product.variantDetails) && product.variantDetails.length > 0 && (
                              <s-button
                                variant="tertiary"
                                size="slim"
                                onClick={() => setOpenVariantProductId(openVariantProductId === product.id ? null : product.id)}
                              >
                                {openVariantProductId === product.id ? 'Ocultar variantes' : 'Consultar variantes'}
                              </s-button>
                            )}
                          </s-table-cell>
                        </s-table-row>
                      );

                      if (openVariantProductId === product.id && Array.isArray(product.variantDetails) && product.variantDetails.length > 0) {
                        rows.push(
                          <s-table-row key={product.id + '-variants'}>
                            <s-table-cell colSpan={11} style={{ background: '#f6f6f7', padding: '16px 24px' }}>
                              <div className={styles.variantAccordion}>
                                <s-stack gap="tight">
                                  {product.variantDetails.map((v, idx) => (
                                    <s-box key={idx} background="subdued" borderRadius="base" padding="tight">
                                      <s-text variant="body-xs" fontWeight="semibold">
                                        {v.title ? v.title : 'Variante'}
                                      </s-text>
                                      <s-text variant="body-xs" tone="subdued">
                                        Color: {v.color || 'N/A'}
                                      </s-text>
                                      <s-text variant="body-xs" tone="success">
                                        Precio: {v.price || 'N/A'}
                                      </s-text>
                                    </s-box>
                                  ))}
                                </s-stack>
                              </div>
                            </s-table-cell>
                          </s-table-row>
                        );
                      }
                      return rows;
                    })}
                  </s-table-body>
                </s-table>

                {/* PAGINACIÓN */}
                <s-stack rowGap="large" direction="inline" alignItems="center" justifyContent="space-between">
                  <s-stack alignment="center">
                    <s-text variant="caption" tone="subdued">
                      Mostrando {startIndex + 1} - {Math.min(endIndex, processedProducts?.length || 0)} de {processedProducts?.length || 0} productos
                    </s-text>
                  </s-stack>
                  {totalPages > 1 && (
                    <s-stack gap="base" direction="inline">
                      <s-button
                        variant="tertiary"
                        onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                        disabled={currentPage === 1}
                      >
                        ← Anterior
                      </s-button>

                      <s-stack gap="tight" direction="inline">
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          const pageNum = Math.max(1, currentPage - 2) + i;
                          if (pageNum <= totalPages) {
                            return (
                              <s-button
                                key={pageNum}
                                variant={currentPage === pageNum ? "primary" : "tertiary"}
                                size="slim"
                                onClick={() => setCurrentPage(pageNum)}
                              >
                                {pageNum}
                              </s-button>
                            );
                          }
                          return null;
                        })}
                      </s-stack>

                      <s-button
                        variant="tertiary"
                        onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                        disabled={currentPage === totalPages}
                      >
                        Siguiente →
                      </s-button>
                    </s-stack>
                  )}
                </s-stack>
              </s-stack>
            </s-card>
          </s-section>
        )}

        {/* TABLA DE PRODUCTOS AGRUPADOS POR MODELO Y VARIANTES */}
        {grupos.length > 0 && (
          <s-section>
            <s-card>
              <s-stack gap="large">
                <s-text variant="heading-md" fontWeight="bold">
                  📦 Productos Agrupados por Modelo ({grupos.length})
                </s-text>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Modelo</s-table-header>
                    <s-table-header>Acción</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {grupos.map((grupo, idx) => (
                      <React.Fragment key={idx}>
                        {/* Fila principal: modelo */}
                        <s-table-row>
                          <s-table-cell>
                            <s-text variant="heading-md">{grupo[0].model}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-button
                              variant="tertiary"
                              size="slim"
                              onClick={() => setOpenVariantGroupIdx(openVariantGroupIdx === idx ? null : idx)}
                            >
                              {openVariantGroupIdx === idx ? 'Ocultar variantes' : 'Ver variantes'}
                            </s-button>
                          </s-table-cell>
                        </s-table-row>
                        {/* Variantes en acordeón */}
                        {openVariantGroupIdx === idx && (
                          <s-table-row>
                            <s-table-cell colSpan={2}>
                              <div className={styles.variantAccordion}>
                                <s-stack gap="tight">
                                  {grupo.map((v, vIdx) => (
                                    <s-box key={vIdx} background="subdued" borderRadius="base" padding="tight">
                                      <s-text variant="body-xs" fontWeight="semibold">
                                        {v.title || v.model}
                                      </s-text>
                                      <s-text variant="body-xs" tone="subdued">
                                        Color: {v.color || 'N/A'}
                                      </s-text>
                                      <s-text variant="body-xs" tone="success">
                                        Precio: {v.price || 'N/A'}
                                      </s-text>
                                    </s-box>
                                  ))}
                                </s-stack>
                              </div>
                            </s-table-cell>
                          </s-table-row>
                        )}
                      </React.Fragment>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            </s-card>
          </s-section>
        )}
      </s-page>
    </div>
  );
}