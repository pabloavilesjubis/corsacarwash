// GENERADO por scripts/build-api.mjs desde server/ — no editar a mano.

// server/cuponera/handler.ts
import { randomInt } from "node:crypto";

// server/correo/datos.ts
import { createClient } from "@supabase/supabase-js";
function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el servidor");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function esDeCuponera(user) {
  return user.app_metadata?.portal === "cuponera";
}
async function usuarioDe(db, jwt) {
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw Object.assign(new Error("La sesi\xF3n venci\xF3. Volv\xE9 a ingresar."), { status: 401 });
  if (esDeCuponera(data.user)) throw Object.assign(new Error("No autorizado"), { status: 403 });
  const { data: perfil } = await db.from("profiles").select("organization_id").eq("id", data.user.id).maybeSingle();
  if (!perfil?.organization_id) throw Object.assign(new Error("El usuario no pertenece a ninguna organizaci\xF3n"), { status: 403 });
  return { userId: data.user.id, orgId: perfil.organization_id };
}
async function tienePermiso(db, userId, codigo) {
  const [{ data: ur }, { data: perm }] = await Promise.all([
    db.from("user_roles").select("role_id").eq("user_id", userId),
    db.from("permissions").select("id").eq("code", codigo).maybeSingle()
  ]);
  const roles = (ur ?? []).map((r) => r.role_id);
  if (!perm || roles.length === 0) return false;
  const { data: activos } = await db.from("roles").select("id").in("id", roles).eq("active", true);
  const ids = (activos ?? []).map((r) => r.id);
  if (ids.length === 0) return false;
  const { count } = await db.from("role_permissions").select("role_id", { count: "exact", head: true }).in("role_id", ids).eq("permission_id", perm.id);
  return (count ?? 0) > 0;
}
async function registrarEnvio(db, fila2) {
  const { error } = await db.from("envios_correo").insert(fila2);
  if (error) console.error("[correo] no se pudo registrar el env\xEDo", error.message);
}

// server/correo/plantillas.ts
var TINTA = "#16191A";
var LIMA = "#DFF56B";
var FONDO = "#EFF2EC";
var GRIS = "#5E6661";
var esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function fila(etiqueta, valor, fuerte = false) {
  return `<tr>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;color:${GRIS};font-size:13px">${esc(etiqueta)}</td>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;text-align:right;font-size:13px;color:${TINTA};${fuerte ? "font-weight:700" : ""}">${valor}</td>
  </tr>`;
}
function tarjeta(titulo, filas) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;border:1px solid #E3E8DE;border-radius:14px">
    <tr><td style="padding:14px 18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GRIS};margin-bottom:4px">${esc(titulo)}</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${filas}</table>
    </td></tr>
  </table>`;
}
function aviso(texto, tono = "lima") {
  const [fondo, borde] = tono === "lima" ? ["#F6FCDA", LIMA] : ["#FFF6E5", "#F2C46B"];
  return `<div style="background:${fondo};border-left:4px solid ${borde};border-radius:10px;padding:12px 14px;font-size:13.5px;color:${TINTA};margin:16px 0">${texto}</div>`;
}
function layout(args) {
  const e = args.emisor ?? {};
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(args.titulo)}</title></head>
<body style="margin:0;padding:0;background:${FONDO};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${TINTA}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(args.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${FONDO}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #E3E8DE">
      <tr><td style="background:${TINTA};padding:24px 28px 20px" align="left">
        <img src="${esc(args.appUrl)}/marca/corsa-email.png" width="150" alt="CORSA Carwash" style="display:block;width:150px;height:auto;border:0"/>
        <div style="width:44px;height:4px;background:${LIMA};border-radius:2px;margin-top:14px"></div>
      </td></tr>
      <tr><td style="padding:26px 28px 8px">
        <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;font-weight:800;color:${TINTA}">${esc(args.titulo)}</h1>
        ${args.cuerpo}
      </td></tr>
      <tr><td style="padding:18px 28px 24px;border-top:1px solid #EEF1EA;font-size:11.5px;line-height:1.55;color:${GRIS}">
        <strong style="color:${TINTA}">${esc(e.nombreComercial || "CORSA Carwash")}</strong>${e.razonSocial ? ` \xB7 ${esc(e.razonSocial)}` : ""}<br/>
        ${e.direccion ? `${esc(e.direccion)}<br/>` : ""}
        ${[e.telefono ? `Tel. ${esc(e.telefono)}` : "", e.correo ? esc(e.correo) : ""].filter(Boolean).join(" \xB7 ")}
      </td></tr>
    </table>
    <div style="font-size:11px;color:#8A928D;margin-top:12px">Este correo se envi\xF3 autom\xE1ticamente desde el sistema de CORSA Carwash.</div>
  </td></tr>
</table>
</body></html>`;
}
function parrafo(html) {
  return `<p style="margin:10px 0;font-size:14.5px;line-height:1.6;color:#2B302E">${html}</p>`;
}
function boton(texto, url) {
  return `<a href="${esc(url)}" style="display:inline-block;background:${TINTA};color:${LIMA};text-decoration:none;font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:10px;margin:6px 0 4px">${esc(texto)}</a>`;
}

// server/correo/smtp.ts
import nodemailer from "nodemailer";
var CORREO_CORSA = "corsacarwash@gmail.com";
function transporte() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw Object.assign(new Error("El correo no est\xE1 configurado en el servidor (SMTP)."), { status: 500 });
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(SMTP_SECURE ?? "true").toLowerCase() !== "false",
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
  });
}
function remitente() {
  const correo = process.env.SMTP_FROM || process.env.SMTP_USER || CORREO_CORSA;
  return `"${(process.env.SMTP_FROM_NAME || "CORSA Carwash").replace(/"/g, "")}" <${correo}>`;
}

// server/cuponera/handler.ts
var ErrorHttp = class extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
};
var CORREO_VALIDO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
var uuid = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
var BLOQUEO = "876000h";
function claveTemporal() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const parte = (n) => Array.from({ length: n }, () => letras[randomInt(letras.length)]).join("");
  return `${parte(4)}-${parte(4)}-${parte(4)}`;
}
async function nombreDelCliente(db, customerId) {
  const { data: c } = await db.from("customers").select("customer_type, first_name, last_name, trade_name, legal_name").eq("id", customerId).maybeSingle();
  if (!c) return "tu empresa";
  return c.customer_type === "company" ? c.legal_name || c.trade_name || "tu empresa" : `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "tu empresa";
}
async function enviarAcceso(args) {
  const empresa = await nombreDelCliente(args.db, args.customerId);
  const portal = `${args.appUrl}/cuponera`;
  const asunto = args.nuevo ? "Tu acceso a la Cuponera Digital de CORSA" : "Tu nueva contrase\xF1a de la Cuponera Digital de CORSA";
  const html = layout({
    appUrl: args.appUrl,
    preheader: args.nuevo ? `Ya puedes entregar los cupones de ${empresa} desde la Cuponera Digital.` : "Se restableci\xF3 tu contrase\xF1a.",
    titulo: args.nuevo ? "Bienvenido a la Cuponera Digital" : "Tu contrase\xF1a se restableci\xF3",
    cuerpo: parrafo(args.nuevo ? `Hola, ${esc(args.nombre.split(" ")[0])}: CORSA Carwash habilit\xF3 la Cuponera Digital de <strong>${esc(empresa)}</strong>. Desde ah\xED ves cu\xE1ntos cupones compraron, cu\xE1ntos se han entregado y cu\xE1ntos quedan, y los entregas por correo o en PDF.` : `Hola, ${esc(args.nombre.split(" ")[0])}: CORSA Carwash restableci\xF3 tu contrase\xF1a de la Cuponera Digital de <strong>${esc(empresa)}</strong>.`) + tarjeta("Tus datos de acceso", [
      fila("Portal", `<a href="${esc(portal)}" style="color:#16191A">${esc(portal.replace(/^https?:\/\//, ""))}</a>`),
      fila("Usuario", esc(args.correo)),
      fila("Contrase\xF1a temporal", `<span style="font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.06em">${esc(args.clave)}</span>`)
    ].join("")) + aviso("Al ingresar te pediremos cambiar esta contrase\xF1a por una tuya.") + parrafo(boton("Ingresar a la Cuponera Digital", portal)) + parrafo("Si no esperabas este correo, comun\xEDcate con CORSA Carwash.")
  });
  try {
    const info = await transporte().sendMail({ from: remitente(), to: [args.correo], subject: asunto, html });
    await registrarEnvio(args.db, {
      organization_id: args.orgId,
      tipo: "cuponera_acceso",
      customer_id: args.customerId,
      destinatarios: [args.correo],
      bcc: [],
      asunto,
      status: "sent",
      message_id: info.messageId ?? null,
      created_by: args.userId
    });
    return { enviado: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await registrarEnvio(args.db, {
      organization_id: args.orgId,
      tipo: "cuponera_acceso",
      customer_id: args.customerId,
      destinatarios: [args.correo],
      bcc: [],
      asunto,
      status: "failed",
      error: error.slice(0, 500),
      created_by: args.userId
    });
    return { enviado: false, error };
  }
}
async function crearUsuario(db, quien, appUrl, b) {
  const nombre = String(b.nombre ?? "").trim();
  const correo = String(b.correo ?? "").trim().toLowerCase();
  if (!uuid(b.customerId)) throw new ErrorHttp(400, "Falta el cliente");
  if (!nombre || nombre.length > 120) throw new ErrorHttp(400, "Escrib\xED el nombre del usuario");
  if (!CORREO_VALIDO.test(correo)) throw new ErrorHttp(400, "El correo no es v\xE1lido");
  const { data: cc } = await db.from("cuponera_clientes").select("customer_id, activa").eq("customer_id", b.customerId).eq("organization_id", quien.orgId).maybeSingle();
  if (!cc) throw new ErrorHttp(409, "Primero habilit\xE1 la Cuponera Digital del cliente");
  const clave = claveTemporal();
  const { data: creado, error } = await db.auth.admin.createUser({
    email: correo,
    password: clave,
    email_confirm: true,
    // app_metadata: sólo lo escribe el service role. Es lo que la base mira
    // para no crearle profile y para encerrarlo en las RPC del portal.
    app_metadata: { portal: "cuponera" },
    user_metadata: { display_name: nombre }
  });
  if (error || !creado?.user) {
    if (/already|registered|exists|duplicate/i.test(error?.message ?? "")) {
      throw new ErrorHttp(409, "Ese correo ya tiene una cuenta en el sistema de CORSA. Us\xE1 otro correo.");
    }
    throw new ErrorHttp(500, "No se pudo crear el usuario");
  }
  const nuevoId = creado.user.id;
  await db.from("profiles").delete().eq("id", nuevoId);
  const { error: errFila } = await db.from("cuponera_usuarios").insert({
    user_id: nuevoId,
    organization_id: quien.orgId,
    customer_id: b.customerId,
    nombre,
    correo,
    activo: true,
    debe_cambiar_clave: true,
    created_by: quien.userId
  });
  if (errFila) {
    await db.auth.admin.deleteUser(nuevoId);
    throw new ErrorHttp(500, "No se pudo registrar el usuario; se revirti\xF3 la creaci\xF3n");
  }
  const correoEnviado = b.enviarCorreo ? await enviarAcceso({ db, orgId: quien.orgId, userId: quien.userId, customerId: b.customerId, appUrl, nombre, correo, clave, nuevo: true }) : null;
  return { status: 201, body: { ok: true, userId: nuevoId, correo, clave, correoEnviado } };
}
async function filaDeUsuario(db, orgId, userId) {
  if (!uuid(userId)) throw new ErrorHttp(400, "Falta el usuario");
  const { data: u } = await db.from("cuponera_usuarios").select("user_id, customer_id, nombre, correo, activo").eq("user_id", userId).eq("organization_id", orgId).maybeSingle();
  if (!u) throw new ErrorHttp(404, "No existe ese usuario de cuponera");
  return u;
}
async function restablecerClave(db, quien, appUrl, b) {
  const u = await filaDeUsuario(db, quien.orgId, b.userId);
  const clave = claveTemporal();
  const { error } = await db.auth.admin.updateUserById(u.user_id, { password: clave });
  if (error) throw new ErrorHttp(500, "No se pudo cambiar la contrase\xF1a");
  await db.from("cuponera_usuarios").update({ debe_cambiar_clave: true }).eq("user_id", u.user_id);
  const correoEnviado = b.enviarCorreo ? await enviarAcceso({ db, orgId: quien.orgId, userId: quien.userId, customerId: u.customer_id, appUrl, nombre: u.nombre, correo: u.correo, clave, nuevo: false }) : null;
  return { status: 200, body: { ok: true, clave, correo: u.correo, correoEnviado } };
}
async function cambiarAcceso(db, quien, b) {
  const u = await filaDeUsuario(db, quien.orgId, b.userId);
  const activo = b.activo === true;
  const { error } = await db.auth.admin.updateUserById(u.user_id, { ban_duration: activo ? "none" : BLOQUEO });
  if (error) throw new ErrorHttp(500, "No se pudo cambiar el acceso");
  await db.from("cuponera_usuarios").update({ activo }).eq("user_id", u.user_id);
  return { status: 200, body: { ok: true, activo } };
}
async function manejar(args) {
  try {
    const jwt = (args.auth ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) throw new ErrorHttp(401, "Falta la sesi\xF3n");
    const db = admin();
    const quien = await usuarioDe(db, jwt).catch((e) => {
      throw new ErrorHttp(e.status ?? 401, e.message);
    });
    if (!await tienePermiso(db, quien.userId, "cuponera.manage")) {
      throw new ErrorHttp(403, "No autorizado: se requiere cuponera.manage");
    }
    const b = args.cuerpo ?? {};
    if (b.accion === "crear_usuario") return await crearUsuario(db, quien, args.appUrl, b);
    if (b.accion === "restablecer_clave") return await restablecerClave(db, quien, args.appUrl, b);
    if (b.accion === "acceso") return await cambiarAcceso(db, quien, b);
    throw new ErrorHttp(400, "Solicitud inv\xE1lida");
  } catch (e) {
    if (e instanceof ErrorHttp) return { status: e.status, body: { ok: false, error: e.message } };
    console.error("[cuponera]", e);
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : "Error interno" } };
  }
}

// server/cuponera/entrada.ts
var config = { maxDuration: 30 };
async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "M\xE9todo no permitido" });
    return;
  }
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const r = await manejar({ auth: req.headers.authorization, cuerpo: req.body, appUrl: `${proto}://${host}` });
  res.status(r.status).json(r.body);
}
export {
  config,
  handler as default
};
