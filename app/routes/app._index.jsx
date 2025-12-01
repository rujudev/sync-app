import { ProgressBar } from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';
import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from "react-router";
import Pagination from '../components/Pagination.jsx';
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
    let finalProducts = [];

    // Solo parsear (sin admin = solo parsing y estadísticas, no creación en Shopify)
    syncXmlString(admin, xmlUrl)
      .then(parsedProducts => {
        if (!parsedProducts || parsedProducts.length === 0) {
          return Response.json({ error: "No se encontraron productos en el XML" }, { status: 400 });
        }

        finalProducts = parsedProducts;
      });

    const shopDomain = session.shop.replace('.myshopify.com', '');

    // Devolver productos parseados al cliente
    return Response.json({
      success: true,
      totalProducts: finalProducts.length,
      products: finalProducts, // ← Los productos van al cliente
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
  const fetcher = useFetcher();
  const [syncState, setSyncState] = useState(null); // Estado unificado

  const [groupStatus, setGroupStatus] = useState([]);
  const [variantStatusByGroup, setVariantStatusByGroup] = useState({});

  // Función para limpiar todo el estado de importación
  const resetAll = async () => {
    try {
      await fetch("/api/sync-cancel");

      console.log("🔴 Cancelación solicitada al backend");
      setGroupStatus([]);
      setVariantStatusByGroup({});
    } catch (e) {
      console.warn("No se pudo notificar la cancelación al backend", e);
    }
  };

  const actionData = fetcher.data;
  const isLoading = fetcher.state === "submitting";
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const totalPages = Math.ceil(groupStatus.filter(g => g.status !== "pending").length / pageSize);
  const paginated = groupStatus
    .sort((a, b) => {
      const order = {
        processing: 0,
        error: 1,
        pending: 2,
        success: 3,
      };

      return order[a.status] - order[b.status];
    })
    .filter(g => g.status !== "pending").slice((page - 1) * pageSize, page * pageSize);

  const groupStatusTotals = useMemo(() => {
    let created = 0, updated = 0, skipped = 0, errors = 0;

    for (const g of groupStatus) {
      created += g.created || 0;
      updated += g.updated || 0;
      skipped += g.skipped || 0;
      errors += g.errors || 0;
    }

    return {
      created,
      updated,
      skipped,
      errors,
      totalProcessedProducts: created + updated + skipped + errors
    };
  }, [groupStatus])

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

    es.addEventListener("groups_list", (e) => {
      const d = JSON.parse(e.data);


      setGroupStatus(
        d.groups.map(g => ({
          id: g,
          name: g,
          status: 'pending',
          error: null,
        })
        ));

      setSyncState(prev => ({
        ...prev,
        currentStep: `Detectados ${d.groups.length} grupos`
      }));
    });

    es.addEventListener("groups-detected", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Detectados ${Object.keys(d.groups).length} grupos`
      }));
    });

    es.addEventListener("group_start", e => {
      const d = JSON.parse(e.data);

      setGroupStatus(prev => {
        return prev.map(g =>
          g.id === d.id ? {
            ...d,
            status: "processing",
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 0
          } : g
        )
      });

      setSyncState(prev => ({
        ...prev,
        currentStep: `Iniciando grupo ${d.id}`
      }));
    });

    es.addEventListener('group_unchanged', e => {
      const d = JSON.parse(e.data);


      setGroupStatus(prev => prev.map(g =>
        g.id === d.id
          ? { ...g, status: "unchanged" }
          : g
      )
      );
    })

    es.addEventListener("group_end", e => {
      const d = JSON.parse(e.data);


      setGroupStatus(prev => {
        return prev.map(g =>
          g.id === d.id ? { ...g, status: "success" } : g
        )
      });
    });

    es.addEventListener("group_error", e => {
      const d = JSON.parse(e.data);


      setGroupStatus(prev =>
        prev.map(g =>
          g.id === d.id ? { ...g, status: "error", error: d.error } : g
        )
      );

      setSyncState(prev => ({
        ...prev,
        currentStep: `Error en grupo ${d.id}`,
        errorItems: prev.errorItems + 1
      }));
    });

    es.addEventListener("product_created", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Producto creado: ${d.product?.title || d.groupId}`,
        recentProducts: [
          { type: "created", title: d.product?.title, sku: null },
          ...((prev.recentProducts || []).slice(0, 9))
        ]
      }));
    });

    es.addEventListener("product_create_request", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Creando producto: ${d.title}`,
        recentProducts: [
          { type: "request", title: d.title, groupId: d.groupId },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));
    });

    es.addEventListener("product_media_uploaded", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Imágenes subidas (${d.count}) para producto ${d.productId}`
      }));
    });

    es.addEventListener("product_media_added", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Imágenes añadidas al producto ${d.productId}`
      }));
    });

    es.addEventListener("product_synced", e => {
      const d = JSON.parse(e.data);

      setSyncState(prev => ({
        ...prev,
        processedItems: prev.processedItems + 1,
        createdItems: prev.createdItems + (d.createdVariants || 0),
        updatedItems: prev.updatedItems + (d.updatedVariants || 0),
        currentStep: `Producto sincronizado (${d.createdVariants} creadas / ${d.updatedVariants} actualizadas)`,
        recentProducts: [
          {
            type: "updated",
            title: d.groupId,
            created: d.createdVariants,
            updated: d.updatedVariants
          },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));
    });

    es.addEventListener("variant_create_detected", e => {
      const d = JSON.parse(e.data);

      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant.sku]: {
            status: "detected_create",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_update_detected", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant.sku]: {
            status: "detected_update",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_processing_start", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...prev[d.groupId],
          [d.variant.sku]: {
            status: "processing",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_processing_success", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...prev[d.groupId],
          [d.variant.sku]: {
            status: "success",
            action: d.action,
            variant: d.variant
          }
        }
      }));

      setGroupStatus(prev =>
        prev.map(g => g.id === d.groupId ? {
          ...g,
          created: g.created + (d.action === "created" ? 1 : 0),
          updated: g.updated + (d.action === "updated" ? 1 : 0),
          skipped: g.skipped + (d.action === "skipped" ? 1 : 0)
        }
          : g
        )
      )
    });

    es.addEventListener("variant_processing_error", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant.sku || `error-${Date.now()}`]: {
            status: "error",
            message: d.message
          }
        }
      }));

      setGroupStatus(prev =>
        prev.map(g =>
          g.id === d.groupId ? {
            ...g,
            status: 'error',
            errors: g.errors + 1
          }
            : g
        )
      )
    });

    es.addEventListener("sync-end", () => {
      setSyncState(prev => ({
        ...prev,
        isActive: false,
        status: "sync-completed",
        currentStep: "Sincronización completada"
      }));

      resetAll();
    });

    es.addEventListener("sync-cancelled", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        isActive: false,
        status: "cancelled",
        currentStep: d.message || "Sincronización cancelada por el usuario"
      }));
    });

    return () => es.close();
  }, []);

  // ✨ NUEVO: useEffect que inicia procesamiento cuando recibimos productos del action
  useEffect(() => {
    if (!actionData?.success || !actionData?.products) return;

    // Llamar al endpoint de procesamiento
    const startProcessing = async () => {
      try {
        await fetch('/api/process-products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            products: actionData.products,
            shopDomain: actionData.shopDomain
          })
        });

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
                    {import.meta.env.MODE === 'development' && (
                      <s-button
                        variant="secondary"
                        size="large"
                        onClick={async () => {
                          const result = await fetch("/api/get-colors", { method: "POST" });
                          const data = await result.json();
                          // console.log("🎨 COLORES OBTENIDOS:", data.colors);
                          alert("Colores obtenidos. Mira la consola.");
                        }}
                      >
                        🎨 Obtener colores existentes
                      </s-button>
                    )}
                    {syncState?.status === 'syncing' && (
                      <s-button
                        variant="secondary"
                        size="large"
                        onClick={resetAll}
                      >
                        🛑 Cancelar importación
                      </s-button>
                    )}
                  </s-stack>
                </s-stack>
              </fetcher.Form>
            </s-stack>
          </s-card>
        </s-section>

        {/* SECCIÓN DE PROGRESO EN TIEMPO REAL */}
        {groupStatus.length > 0 && (
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
                    progress={((groupStatusTotals.totalProcessedProducts || 0) / (syncState?.totalItems || 1)) * 100}
                    size="small"
                  />
                  <s-stack direction="inline" columnGap="base" blockSize="auto" justifyContent="center">
                    <s-text variant="body-sm" tone="subdued">
                      {groupStatusTotals.totalProcessedProducts} / {syncState?.totalItems || 0} productos individuales
                    </s-text>
                    <s-divider direction="block" />
                    <s-text variant="caption" tone="subdued">
                      {Math.round(((groupStatusTotals.totalProcessedProducts || 0) / (syncState?.totalItems || 1)) * 100)}% completado
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
                        {groupStatusTotals.created}
                      </s-text>
                      <s-badge tone="success" size="small">
                        🆕 Creados
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* PRODUCTOS ACTUALIZADOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="info">
                        {groupStatusTotals.updated}
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
                        {groupStatusTotals.skipped}
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
                        {groupStatusTotals.errors}
                      </s-text>
                      <s-badge tone="critical" size="small">
                        ❌ Errores
                      </s-badge>
                    </s-stack>
                  </s-box>
                </s-grid>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        {/* MENSAJE DE ÉXITO FINAL */}
        {syncState?.status === 'sync-completed' && (
          <s-section>
            <s-card>
              <s-banner tone="success">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    ✅ Productos importados exitosamente
                  </s-text>
                  <s-text variant="body-sm">
                    📦 {groupStatusTotals.totalProcessedProducts} productos importados
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

        {/* TABLA DE PRODUCTOS AGRUPADOS POR MODELO Y VARIANTES */}
        {groupStatus.length > 0 && (
          <s-section>
            <s-box padding="500">
              {/* Lista detallada de grupos */}
              <s-stack vertical spacing="300">
                <s-stack rowGap="large">
                  {paginated
                    .map(g => (
                      <s-box key={g.id} padding="small" >
                        <s-stack gap="small">

                          {/* CABECERA DEL GRUPO */}
                          <s-stack direction="inline" alignment="space-between" gap="base">
                            <s-stack direction="inline" alignment="center" gap="200">
                              {/* icono/estado */}
                              {g.status === "processing" ? (
                                <s-spinner size="small" />
                              ) : g.status === "pending" ? (
                                <s-icon type="clock" tone="neutral" />
                              ) : g.status === "success" ? (
                                <s-icon type="check-circle-filled" tone="success" />
                              ) : g.status === "unchanged" ? (
                                <s-icon type="minus-circle" tone="subdued" />
                              ) : <s-icon type="alert-circle" tone="critical" />}

                              <s-text variant="body-md" fontWeight="semibold" className="capitalize">
                                <span className='capitalize'>{g.name || g.id}</span>
                              </s-text>
                            </s-stack>

                            <s-badge
                              tone={
                                g.status === "processing" ? "info" :
                                  g.status === "pending" ? "subdued" :
                                    g.status === "success" ? "success" : "critical"
                              }
                              size="small"
                            >
                              {g.status === "processing" && "En proceso…"}
                              {g.status === "pending" && "Pendiente"}
                              {g.status === "success" && "Completado"}
                              {g.status === "error" && "Con errores"}
                            </s-badge>
                          </s-stack>

                          {/* RESUMEN NÚMEROS */}
                          <s-stack direction="inline" columnGap="large" blockSize="auto" alignItems="center">
                            <s-badge tone="success" size="small">🆕 Creadas {g.created || 0}</s-badge>
                            <s-badge tone="info" size="small">🔄 Actualizadas {g.updated || 0}</s-badge>
                            <s-badge tone="warning" size="small">⏭️ Omitidas {g.skipped || 0}</s-badge>
                            {(g.errors || 0) > 0 && <s-badge tone="critical" size="small">❌ Errores {g.errors}</s-badge>}
                            <s-text variant="caption" tone="subdued" style={{ marginLeft: 8 }}>
                              {g.totalVariants ? `${g.totalVariants} variantes` : ''}
                            </s-text>
                          </s-stack>

                          <s-divider />

                          {/* VARIANTES: grid responsive */}
                          {variantStatusByGroup[g.id] && (
                            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(360px, 1fr))" gap="base" paddingBlockStart="200">
                              {Object.entries(variantStatusByGroup[g.id]).map(([sku, info]) => (
                                <s-box key={sku} padding="base">
                                  <s-stack direction="inline" alignment="start" columnGap="200">
                                    {/* Thumbnail / imagen */}
                                    <s-box blockSize="80px" inlineSize="80px" style={{ flex: '0 0 80px' }}>
                                      <s-image src={info?.variant?.image || ''} alt={sku} inlineSize="fill" />
                                    </s-box>

                                    {/* Datos */}
                                    <s-stack vertical spacing="100" style={{ flex: 1 }}>
                                      <s-text variant="body-sm" fontWeight="medium">
                                        {info?.variant?.capacity || ''} • {info?.variant?.color || ''} • {info?.variant?.condition || ''}
                                      </s-text>
                                      <s-text variant="caption" tone="subdued">{sku}</s-text>

                                      {/* Estado / acción */}
                                      <div style={{ marginTop: 8 }}>
                                        {info?.status === "detected_create" && <s-badge tone="info">Detectada (crear)</s-badge>}
                                        {info?.status === "detected_update" && <s-badge tone="info">Detectada (actualizar)</s-badge>}

                                        {info?.status === "processing" && (
                                          <s-badge tone="warning">
                                            <s-stack direction="inline" alignment="center" gap="100">
                                              <s-spinner size="small" /> Procesando…
                                            </s-stack>
                                          </s-badge>
                                        )}

                                        {info?.status === "success" && (
                                          <s-badge
                                            tone={info.action === "created"
                                              ? "success"
                                              : info.action === "updated"
                                                ? "info"
                                                : info.action === "skipped"
                                                  ? "warning"
                                                  : "critical"
                                            }
                                          >
                                            {info.action === "created"
                                              ? "Creada"
                                              : info.action === "updated"
                                                ? "Actualizada"
                                                : info.action === "skipped"
                                                  ? "Omitida"
                                                  : "Error"
                                            }
                                          </s-badge>
                                        )}

                                        {info?.status === "error" && (
                                          <s-badge tone="critical">Error{info.message ? `: ${info.message}` : ''}</s-badge>
                                        )}
                                      </div>
                                    </s-stack>
                                  </s-stack>
                                </s-box>
                              ))}
                            </s-grid>
                          )}
                        </s-stack>
                      </s-box>
                      // <s-box
                      //   key={g.id}
                      //   padding="base"
                      //   background={
                      //     g.status === "success" ? "subdued" :
                      //       g.status === "error" ? "strong" : "transparent"
                      //   }
                      //   borderRadius="large"
                      //   borderWidth="base"
                      //   borderColor={
                      //     g.status === "success" ? "subdued" :
                      //       g.status === "error" ? "strong" : "base"
                      //   }
                      // >
                      //   <s-stack alignment="space-between" rowGap='large'>
                      //     <s-stack gap="large-200">
                      //       <s-stack direction='inline' spacing="300" alignment="center">
                      //         <s-stack direction="inline">
                      //           {g.status === "processing" ? (
                      //             <s-spinner size="small" />
                      //           ) : (
                      //             <s-icon type={
                      //               g.status === "pending" ? "clock" :
                      //                 g.status === "success" ? "check-circle-filled" : null
                      //             }
                      //               tone={
                      //                 g.status === "pending" ? "neutral" :
                      //                   g.status === "success" ? "success" : null
                      //               }
                      //             />
                      //           )}
                      //           <s-text variant="bodyMd" fontWeight="semibold">
                      //             <span className='capitalize'>{g.id}</span>
                      //           </s-text>
                      //         </s-stack>
                      //       </s-stack>

                      //       {/* Mensaje de error si existe */}
                      //       {g.status === "error" && g.error && (
                      //         <s-box paddingBlockStart="100">
                      //           <s-banner tone="critical" hideIcon>
                      //             <s-text variant="bodySm">
                      //               {g.error}
                      //             </s-text>
                      //           </s-banner>
                      //         </s-box>
                      //       )}
                      //     </s-stack>

                      //     {variantStatusByGroup[g.id] && (
                      //       <s-grid gridTemplateColumns="repeat(auto-fit, minmax(400px, 1fr))" gap="400" paddingBlockStart="200">
                      //         {Object.entries(variantStatusByGroup[g.id]).map(([sku, info]) => (
                      //           <s-stack
                      //             key={sku}
                      //             direction="inline"
                      //             spacing="300"
                      //             alignment="center"
                      //             borderWidth="025"
                      //             borderColor="border-subdued"
                      //             padding="200"
                      //             borderRadius="200"
                      //           >
                      //             <s-box blockSize='100px' inlineSize='100px'>
                      //               <s-image
                      //                 src={info?.variant?.image}
                      //                 alt={info?.variant?.title || sku}
                      //                 inlineSize="fill"
                      //               />
                      //             </s-box>

                      //             {/* SKU / descripción */}
                      //             <s-text variant="bodySm" fontWeight="medium">
                      //               {info?.variant?.capacity} / {info?.variant?.color} / {info?.variant?.condition}
                      //             </s-text>

                      //             {/* ESTADOS */}
                      //             {info?.status === "detected_create" && (
                      //               <s-badge tone="info">Detectada (crear)</s-badge>
                      //             )}

                      //             {info?.status === "detected_update" && (
                      //               <s-badge tone="info">Detectada (actualizar)</s-badge>
                      //             )}

                      //             {info?.status === "processing" && (
                      //               <s-badge tone="warning">
                      //                 <s-stack direction="inline" spacing="100" alignment="center">
                      //                   <s-spinner size="small" /> Procesando…
                      //                 </s-stack>
                      //               </s-badge>
                      //             )}

                      //             {info?.status === "success" && (
                      //               <s-badge tone="success">
                      //                 {info.action === "created" ? "Creada" : "Actualizada"}
                      //               </s-badge>
                      //             )}

                      //             {info.status === "error" && (
                      //               <s-badge tone="critical">
                      //                 Error: {info.message || "Desconocido"}
                      //               </s-badge>
                      //             )}
                      //           </s-stack>
                      //         ))}
                      //       </s-grid>
                      //     )}
                      //   </s-stack>
                      // </s-box>
                    ))}
                </s-stack>
              </s-stack>

              <Pagination
                page={page}
                totalPages={totalPages}
                totalItems={groupStatus.length}
                pageSize={pageSize}
                onChange={newPage => setPage(newPage)}
              />
            </s-box>
          </s-section>
        )}
      </s-page>
    </div>
  );
}