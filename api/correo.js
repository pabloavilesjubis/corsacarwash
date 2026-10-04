// GENERADO por scripts/build-api.mjs desde server/ — no editar a mano.

// server/correo/handler.ts
import nodemailer from "nodemailer";

// src/lib/mh-catalogs.ts
var DEPARTAMENTOS = [
  { codigo: "01", nombre: "Ahuachap\xE1n" },
  { codigo: "02", nombre: "Santa Ana" },
  { codigo: "03", nombre: "Sonsonate" },
  { codigo: "04", nombre: "Chalatenango" },
  { codigo: "05", nombre: "La Libertad" },
  { codigo: "06", nombre: "San Salvador" },
  { codigo: "07", nombre: "Cuscatl\xE1n" },
  { codigo: "08", nombre: "La Paz" },
  { codigo: "09", nombre: "Caba\xF1as" },
  { codigo: "10", nombre: "San Vicente" },
  { codigo: "11", nombre: "Usulut\xE1n" },
  { codigo: "12", nombre: "San Miguel" },
  { codigo: "13", nombre: "Moraz\xE1n" },
  { codigo: "14", nombre: "La Uni\xF3n" }
];
var MUNICIPIOS_POR_DEPARTAMENTO = {
  // 01 — Ahuachapán (12)
  "01": [
    { codigo: "01", nombre: "Ahuachap\xE1n" },
    { codigo: "02", nombre: "Apaneca" },
    { codigo: "03", nombre: "Atiquizaya" },
    { codigo: "04", nombre: "Concepci\xF3n de Ataco" },
    { codigo: "05", nombre: "El Refugio" },
    { codigo: "06", nombre: "Guaymango" },
    { codigo: "07", nombre: "Jujutla" },
    { codigo: "08", nombre: "San Francisco Men\xE9ndez" },
    { codigo: "09", nombre: "San Lorenzo" },
    { codigo: "10", nombre: "San Pedro Puxtla" },
    { codigo: "11", nombre: "Tacuba" },
    { codigo: "12", nombre: "Tur\xEDn" }
  ],
  // 02 — Santa Ana (13)
  "02": [
    { codigo: "01", nombre: "Candelaria de la Frontera" },
    { codigo: "02", nombre: "Coatepeque" },
    { codigo: "03", nombre: "Chalchuapa" },
    { codigo: "04", nombre: "El Congo" },
    { codigo: "05", nombre: "El Porvenir" },
    { codigo: "06", nombre: "Masahuat" },
    { codigo: "07", nombre: "Metap\xE1n" },
    { codigo: "08", nombre: "San Antonio Pajonal" },
    { codigo: "09", nombre: "San Sebasti\xE1n Salitrillo" },
    { codigo: "10", nombre: "Santa Ana" },
    { codigo: "11", nombre: "Santa Rosa Guachipil\xEDn" },
    { codigo: "12", nombre: "Santiago de la Frontera" },
    { codigo: "13", nombre: "Texistepeque" }
  ],
  // 03 — Sonsonate (16)
  "03": [
    { codigo: "01", nombre: "Acajutla" },
    { codigo: "02", nombre: "Armenia" },
    { codigo: "03", nombre: "Caluco" },
    { codigo: "04", nombre: "Cuisnahuat" },
    { codigo: "05", nombre: "Izalco" },
    { codigo: "06", nombre: "Juay\xFAa" },
    { codigo: "07", nombre: "Nahuizalco" },
    { codigo: "08", nombre: "Nahulingo" },
    { codigo: "09", nombre: "Salcoatit\xE1n" },
    { codigo: "10", nombre: "San Antonio del Monte" },
    { codigo: "11", nombre: "San Juli\xE1n" },
    { codigo: "12", nombre: "Santa Catarina Masahuat" },
    { codigo: "13", nombre: "Santa Isabel Ishuat\xE1n" },
    { codigo: "14", nombre: "Santo Domingo de Guzm\xE1n" },
    { codigo: "15", nombre: "Sonsonate" },
    { codigo: "16", nombre: "Sonzacate" }
  ],
  // 04 — Chalatenango (33) — los más comunes
  "04": [
    { codigo: "01", nombre: "Agua Caliente" },
    { codigo: "02", nombre: "Arcatao" },
    { codigo: "04", nombre: "Chalatenango" },
    { codigo: "14", nombre: "La Palma" },
    { codigo: "15", nombre: "Las Flores" },
    { codigo: "17", nombre: "Nueva Concepci\xF3n" },
    { codigo: "20", nombre: "San Francisco Lempa" },
    { codigo: "24", nombre: "San Ignacio" },
    { codigo: "28", nombre: "Tejutla" }
  ],
  // 05 — La Libertad (22) — todos
  "05": [
    { codigo: "01", nombre: "Antiguo Cuscatl\xE1n" },
    { codigo: "02", nombre: "Chiltiup\xE1n" },
    { codigo: "03", nombre: "Ciudad Arce" },
    { codigo: "04", nombre: "Col\xF3n" },
    { codigo: "05", nombre: "Comasagua" },
    { codigo: "06", nombre: "Huiz\xFAcar" },
    { codigo: "07", nombre: "Jayaque" },
    { codigo: "08", nombre: "Jicalapa" },
    { codigo: "09", nombre: "La Libertad" },
    { codigo: "10", nombre: "Santa Tecla" },
    { codigo: "11", nombre: "Nuevo Cuscatl\xE1n" },
    { codigo: "12", nombre: "San Juan Opico" },
    { codigo: "13", nombre: "Quezaltepeque" },
    { codigo: "14", nombre: "Sacacoyo" },
    { codigo: "15", nombre: "San Jos\xE9 Villanueva" },
    { codigo: "16", nombre: "San Mat\xEDas" },
    { codigo: "17", nombre: "San Pablo Tacachico" },
    { codigo: "18", nombre: "Talnique" },
    { codigo: "19", nombre: "Tamanique" },
    { codigo: "20", nombre: "Teotepeque" },
    { codigo: "21", nombre: "Tepecoyo" },
    { codigo: "22", nombre: "Zaragoza" }
  ],
  // 06 — San Salvador (19) — todos
  "06": [
    { codigo: "01", nombre: "Aguilares" },
    { codigo: "02", nombre: "Apopa" },
    { codigo: "03", nombre: "Ayutuxtepeque" },
    { codigo: "04", nombre: "Cuscatancingo" },
    { codigo: "05", nombre: "Ciudad Delgado" },
    { codigo: "06", nombre: "El Paisnal" },
    { codigo: "07", nombre: "Guazapa" },
    { codigo: "08", nombre: "Ilopango" },
    { codigo: "09", nombre: "Mejicanos" },
    { codigo: "10", nombre: "Nejapa" },
    { codigo: "11", nombre: "Panchimalco" },
    { codigo: "12", nombre: "Rosario de Mora" },
    { codigo: "13", nombre: "San Marcos" },
    { codigo: "14", nombre: "San Salvador" },
    { codigo: "15", nombre: "Santiago Texacuangos" },
    { codigo: "16", nombre: "Santo Tom\xE1s" },
    { codigo: "17", nombre: "Soyapango" },
    { codigo: "18", nombre: "Tonacatepeque" },
    { codigo: "19", nombre: "San Mart\xEDn" }
  ],
  // 07 — Cuscatlán (16)
  "07": [
    { codigo: "01", nombre: "Candelaria" },
    { codigo: "02", nombre: "Cojutepeque" },
    { codigo: "03", nombre: "El Carmen" },
    { codigo: "04", nombre: "El Rosario" },
    { codigo: "05", nombre: "Monte San Juan" },
    { codigo: "06", nombre: "Oratorio de Concepci\xF3n" },
    { codigo: "07", nombre: "San Bartolom\xE9 Perulap\xEDa" },
    { codigo: "08", nombre: "San Crist\xF3bal" },
    { codigo: "09", nombre: "San Jos\xE9 Guayabal" },
    { codigo: "10", nombre: "San Pedro Perulap\xE1n" },
    { codigo: "11", nombre: "San Rafael Cedros" },
    { codigo: "12", nombre: "San Ram\xF3n" },
    { codigo: "13", nombre: "Santa Cruz Analquito" },
    { codigo: "14", nombre: "Santa Cruz Michapa" },
    { codigo: "15", nombre: "Suchitoto" },
    { codigo: "16", nombre: "Tenancingo" }
  ],
  // 08 — La Paz (22)
  "08": [
    { codigo: "01", nombre: "Cuyultit\xE1n" },
    { codigo: "02", nombre: "El Rosario" },
    { codigo: "03", nombre: "Jerusal\xE9n" },
    { codigo: "04", nombre: "Mercedes La Ceiba" },
    { codigo: "05", nombre: "Olocuilta" },
    { codigo: "06", nombre: "Para\xEDso de Osorio" },
    { codigo: "07", nombre: "San Antonio Masahuat" },
    { codigo: "08", nombre: "San Emigdio" },
    { codigo: "09", nombre: "San Francisco Chinameca" },
    { codigo: "10", nombre: "San Pedro Masahuat" },
    { codigo: "11", nombre: "San Pedro Nonualco" },
    { codigo: "12", nombre: "San Juan Nonualco" },
    { codigo: "13", nombre: "San Juan Talpa" },
    { codigo: "14", nombre: "San Juan Tepezontes" },
    { codigo: "15", nombre: "San Luis La Herradura" },
    { codigo: "16", nombre: "San Luis Talpa" },
    { codigo: "17", nombre: "San Miguel Tepezontes" },
    { codigo: "18", nombre: "San Rafael Obrajuelo" },
    { codigo: "19", nombre: "Santa Mar\xEDa Ostuma" },
    { codigo: "20", nombre: "Santiago Nonualco" },
    { codigo: "21", nombre: "Tapalhuaca" },
    { codigo: "22", nombre: "Zacatecoluca" }
  ],
  // 09 — Cabañas (9)
  "09": [
    { codigo: "01", nombre: "Cinquera" },
    { codigo: "02", nombre: "Dolores" },
    { codigo: "03", nombre: "Guacotecti" },
    { codigo: "04", nombre: "Ilobasco" },
    { codigo: "05", nombre: "Jutiapa" },
    { codigo: "06", nombre: "San Isidro" },
    { codigo: "07", nombre: "Sensuntepeque" },
    { codigo: "08", nombre: "Tejutepeque" },
    { codigo: "09", nombre: "Victoria" }
  ],
  // 10 — San Vicente (13)
  "10": [
    { codigo: "01", nombre: "Apastepeque" },
    { codigo: "02", nombre: "Guadalupe" },
    { codigo: "03", nombre: "San Cayetano Istepeque" },
    { codigo: "04", nombre: "San Esteban Catarina" },
    { codigo: "05", nombre: "San Ildefonso" },
    { codigo: "06", nombre: "San Lorenzo" },
    { codigo: "07", nombre: "San Sebasti\xE1n" },
    { codigo: "08", nombre: "San Vicente" },
    { codigo: "09", nombre: "Santa Clara" },
    { codigo: "10", nombre: "Santo Domingo" },
    { codigo: "11", nombre: "Tecoluca" },
    { codigo: "12", nombre: "Tepetit\xE1n" },
    { codigo: "13", nombre: "Verapaz" }
  ],
  // 11 — Usulután (23)
  "11": [
    { codigo: "01", nombre: "Alegr\xEDa" },
    { codigo: "02", nombre: "Berl\xEDn" },
    { codigo: "03", nombre: "California" },
    { codigo: "04", nombre: "Concepci\xF3n Batres" },
    { codigo: "05", nombre: "El Triunfo" },
    { codigo: "06", nombre: "Ereguayqu\xEDn" },
    { codigo: "07", nombre: "Estanzuelas" },
    { codigo: "08", nombre: "Jiquilisco" },
    { codigo: "09", nombre: "Jucuapa" },
    { codigo: "10", nombre: "Jucuar\xE1n" },
    { codigo: "11", nombre: "Mercedes Uma\xF1a" },
    { codigo: "12", nombre: "Nueva Granada" },
    { codigo: "13", nombre: "Ozatl\xE1n" },
    { codigo: "14", nombre: "Puerto El Triunfo" },
    { codigo: "15", nombre: "San Agust\xEDn" },
    { codigo: "16", nombre: "San Buenaventura" },
    { codigo: "17", nombre: "San Dionisio" },
    { codigo: "18", nombre: "San Francisco Javier" },
    { codigo: "19", nombre: "Santa Elena" },
    { codigo: "20", nombre: "Santa Mar\xEDa" },
    { codigo: "21", nombre: "Santiago de Mar\xEDa" },
    { codigo: "22", nombre: "Tecap\xE1n" },
    { codigo: "23", nombre: "Usulut\xE1n" }
  ],
  // 12 — San Miguel (20)
  "12": [
    { codigo: "01", nombre: "Carolina" },
    { codigo: "02", nombre: "Chapeltique" },
    { codigo: "03", nombre: "Chinameca" },
    { codigo: "04", nombre: "Chirilagua" },
    { codigo: "05", nombre: "Ciudad Barrios" },
    { codigo: "06", nombre: "Comacar\xE1n" },
    { codigo: "07", nombre: "El Tr\xE1nsito" },
    { codigo: "08", nombre: "Lolotique" },
    { codigo: "09", nombre: "Moncagua" },
    { codigo: "10", nombre: "Nueva Guadalupe" },
    { codigo: "11", nombre: "Nuevo Ed\xE9n de San Juan" },
    { codigo: "12", nombre: "Quelepa" },
    { codigo: "13", nombre: "San Antonio del Mosco" },
    { codigo: "14", nombre: "San Gerardo" },
    { codigo: "15", nombre: "San Jorge" },
    { codigo: "16", nombre: "San Luis de la Reina" },
    { codigo: "17", nombre: "San Miguel" },
    { codigo: "18", nombre: "San Rafael Oriente" },
    { codigo: "19", nombre: "Sesori" },
    { codigo: "20", nombre: "Uluazapa" }
  ],
  // 13 — Morazán (26) — los más comunes
  "13": [
    { codigo: "01", nombre: "Arambala" },
    { codigo: "07", nombre: "Corinto" },
    { codigo: "11", nombre: "Jocoaitique" },
    { codigo: "14", nombre: "Lolotiquillo" },
    { codigo: "20", nombre: "San Francisco Gotera" },
    { codigo: "23", nombre: "Sociedad" }
  ],
  // 14 — La Unión (18)
  "14": [
    { codigo: "01", nombre: "Anamor\xF3s" },
    { codigo: "02", nombre: "Bol\xEDvar" },
    { codigo: "03", nombre: "Concepci\xF3n de Oriente" },
    { codigo: "04", nombre: "Conchagua" },
    { codigo: "05", nombre: "El Carmen" },
    { codigo: "06", nombre: "El Sauce" },
    { codigo: "07", nombre: "Intipuc\xE1" },
    { codigo: "08", nombre: "La Uni\xF3n" },
    { codigo: "09", nombre: "Lislique" },
    { codigo: "10", nombre: "Meanguera del Golfo" },
    { codigo: "11", nombre: "Nueva Esparta" },
    { codigo: "12", nombre: "Pasaquina" },
    { codigo: "13", nombre: "Polor\xF3s" },
    { codigo: "14", nombre: "San Alejo" },
    { codigo: "15", nombre: "San Jos\xE9" },
    { codigo: "16", nombre: "Santa Rosa de Lima" },
    { codigo: "17", nombre: "Yayantique" },
    { codigo: "18", nombre: "Yucuaiqu\xEDn" }
  ]
};
function findMunicipio(deptCodigo, muniCodigo) {
  const munis = MUNICIPIOS_POR_DEPARTAMENTO[deptCodigo];
  return munis?.find((m) => m.codigo === muniCodigo);
}
function findDepartamento(codigo) {
  return DEPARTAMENTOS.find((d) => d.codigo === codigo);
}

// src/utils/fecha.ts
var ZONA_CORSA = "America/El_Salvador";
var FMT_ISO = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_CORSA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
var FMT_PARTES = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA_CORSA,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});
function formatearFechaHora(iso, opciones = {
  day: "2-digit",
  month: "short",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
}) {
  return new Date(iso).toLocaleString("es-SV", { timeZone: ZONA_CORSA, ...opciones });
}

// src/brand/logoCompleto.ts
var LOGO_VIEWBOX = { ancho: 100, alto: 62.97 };
var LOGO_PATH = "M25.1 0.0C28.6 0.0,41.9 0.0,46.1 0.1C50.3 0.2,49.3 0.5,50.2 0.6C51.2 0.8,51.3 0.9,51.8 1.1C52.3 1.3,52.7 1.4,53.2 1.7C53.7 2.0,54.3 2.4,54.8 2.7C55.4 3.1,55.8 3.5,56.3 4.0C56.7 4.5,57.1 5.0,57.4 5.6C57.8 6.2,58.1 6.8,58.3 7.4C58.6 8.0,58.8 8.6,59.0 9.2C59.1 9.9,59.2 10.0,59.3 11.1C59.4 12.2,59.4 14.8,59.4 15.9C59.4 16.9,59.5 16.8,59.5 17.3C59.6 17.7,59.7 18.1,59.9 18.5C60.0 18.8,60.2 19.1,60.5 19.5C60.8 19.9,61.2 20.5,61.7 20.8C62.1 21.2,62.6 21.5,63.1 21.7C63.7 21.9,64.0 22.0,64.8 22.1C65.5 22.2,66.5 22.3,67.6 22.3C68.7 22.3,70.4 22.3,71.5 22.2C72.6 22.1,73.3 22.1,74.1 21.9C75.0 21.7,75.8 21.4,76.7 21.0C77.5 20.7,78.3 20.2,79.1 19.7C79.9 19.1,80.9 18.2,81.4 17.7C81.9 17.2,81.9 17.1,82.1 16.8C82.3 16.5,82.5 16.3,82.6 16.0C82.7 15.7,82.8 15.4,82.9 15.0C83.0 14.7,83.0 14.3,83.0 13.9C83.0 13.6,82.9 13.2,82.9 12.9C82.8 12.6,82.7 12.3,82.5 11.9C82.4 11.6,82.2 11.2,81.9 11.0C81.7 10.7,81.4 10.4,81.1 10.2C80.8 9.9,80.4 9.8,80.1 9.6C79.7 9.5,79.5 9.4,78.9 9.3C78.3 9.2,78.9 9.2,76.4 9.2C73.9 9.1,66.1 9.2,63.9 9.2C61.6 9.1,63.0 9.0,62.8 8.9C62.5 8.8,62.4 8.7,62.2 8.6C62.1 8.5,62.1 8.6,61.9 8.1C61.7 7.7,61.3 6.4,61.0 5.7C60.7 5.1,60.4 4.6,60.1 4.0C59.7 3.5,59.3 2.9,58.9 2.4C58.4 1.8,57.7 1.1,57.4 0.8C57.1 0.5,57.3 0.6,57.3 0.5C57.3 0.5,57.2 0.4,57.4 0.3C57.6 0.3,53.6 0.2,58.5 0.1C63.3 0.1,81.5 0.2,86.4 0.3C91.3 0.3,87.4 0.3,87.9 0.4C88.4 0.5,88.8 0.6,89.3 0.7C89.8 0.9,90.2 1.0,90.7 1.2C91.2 1.5,91.6 1.6,92.1 2.0C92.7 2.4,93.5 3.0,94.0 3.5C94.6 4.1,95.1 4.7,95.5 5.4C95.9 6.0,96.3 6.8,96.6 7.5C96.9 8.3,97.0 9.0,97.1 9.7C97.3 10.5,97.3 11.3,97.3 12.1C97.2 12.8,97.1 13.5,96.9 14.3C96.7 15.0,96.5 15.6,96.2 16.4C95.8 17.2,95.3 18.1,94.7 19.0C94.2 19.9,93.5 20.8,92.9 21.6C92.2 22.4,91.6 23.1,90.8 23.8C90.1 24.5,89.3 25.2,88.4 25.9C87.6 26.5,86.6 27.2,85.7 27.7C84.8 28.3,83.8 28.8,82.8 29.2C81.8 29.6,80.9 29.9,79.9 30.2C78.9 30.5,77.8 30.8,76.8 31.0C75.7 31.1,75.8 31.2,73.7 31.3C71.5 31.4,66.3 31.4,63.9 31.4C61.5 31.4,60.6 31.3,59.5 31.2C58.5 31.1,58.2 31.0,57.6 30.9C57.1 30.8,56.6 30.7,56.1 30.5C55.6 30.3,55.1 30.2,54.7 29.9C54.2 29.7,53.7 29.4,53.2 29.1C52.7 28.8,52.2 28.4,51.8 28.0C51.4 27.6,51.1 27.2,50.7 26.7C50.4 26.3,50.0 25.7,49.7 25.2C49.4 24.6,49.2 24.0,49.0 23.5C48.8 22.9,48.7 22.4,48.5 21.9C48.4 21.3,48.3 21.4,48.2 20.2C48.2 18.9,48.2 15.6,48.1 14.5C48.0 13.3,47.9 13.6,47.8 13.2C47.6 12.8,47.5 12.5,47.2 12.1C46.9 11.7,46.5 11.1,46.0 10.8C45.6 10.4,45.1 10.1,44.5 9.8C44.0 9.6,43.5 9.4,42.8 9.3C42.1 9.2,43.2 9.1,40.5 9.1C37.8 9.0,29.2 9.0,26.5 9.1C23.8 9.1,25.0 9.2,24.4 9.3C23.7 9.5,23.0 9.7,22.5 9.9C21.9 10.2,21.4 10.5,20.9 10.7C20.5 11.0,20.2 11.3,19.8 11.6C19.3 12.0,18.8 12.6,18.4 13.1C18.0 13.5,17.7 14.0,17.4 14.4C17.2 14.8,17.1 15.1,17.0 15.5C16.8 15.9,16.8 16.4,16.7 16.8C16.7 17.2,16.7 17.6,16.8 18.0C16.9 18.4,17.0 18.8,17.2 19.2C17.3 19.5,17.6 20.0,17.9 20.3C18.1 20.7,18.5 21.0,18.9 21.3C19.2 21.5,19.7 21.7,20.1 21.9C20.5 22.0,20.5 22.1,21.5 22.2C22.4 22.2,21.9 22.3,25.6 22.3C29.3 22.3,40.5 22.3,43.7 22.3C46.8 22.3,44.4 22.4,44.7 22.5C44.9 22.5,45.1 22.6,45.2 22.8C45.4 22.9,45.4 22.7,45.6 23.2C45.8 23.7,46.3 25.0,46.5 25.6C46.8 26.2,46.9 26.5,47.2 27.0C47.6 27.5,48.0 28.3,48.5 28.9C49.0 29.5,49.9 30.4,50.2 30.7C50.5 31.1,50.3 30.9,50.3 31.0C50.3 31.1,50.4 31.1,50.2 31.2C50.0 31.2,55.2 31.3,49.2 31.3C43.3 31.3,20.7 31.3,14.6 31.2C8.6 31.2,13.4 31.1,12.8 31.0C12.3 30.9,11.8 30.8,11.3 30.7C10.7 30.5,10.2 30.3,9.7 30.0C9.1 29.8,8.8 29.6,8.2 29.2C7.7 28.9,7.0 28.3,6.4 27.8C5.9 27.3,5.3 26.7,4.9 26.0C4.4 25.4,4.0 24.6,3.7 23.9C3.4 23.2,3.1 22.3,3.0 21.6C2.8 20.8,2.7 20.1,2.7 19.3C2.7 18.6,2.8 17.7,2.9 16.9C3.0 16.1,3.2 15.4,3.5 14.7C3.8 13.9,4.2 13.1,4.7 12.3C5.2 11.4,5.8 10.5,6.4 9.7C7.0 8.9,7.6 8.2,8.3 7.5C9.0 6.7,9.9 5.9,10.7 5.3C11.6 4.6,12.4 4.0,13.3 3.5C14.2 3.0,15.1 2.5,16.1 2.1C17.0 1.6,18.1 1.3,19.1 1.0C20.0 0.7,21.0 0.5,22.0 0.3C23.0 0.2,24.5 0.1,25.0 0.0C25.6 -0.0,21.6 0.0,25.1 0.0ZM9.6 36.9C11.2 36.9,17.5 36.8,19.5 36.9C21.4 36.9,20.8 37.0,21.3 37.1C21.8 37.2,22.1 37.3,22.5 37.6C22.9 37.8,23.5 38.2,23.9 38.6C24.3 39.0,24.6 39.6,24.8 40.1C25.1 40.6,25.2 41.1,25.3 41.8C25.4 42.5,25.3 43.9,25.4 44.5C25.5 45.1,25.6 45.3,25.8 45.6C26.0 45.8,26.1 46.0,26.3 46.1C26.5 46.3,26.6 46.4,27.0 46.5C27.4 46.6,27.9 46.8,28.7 46.8C29.5 46.8,31.1 46.7,31.8 46.6C32.4 46.6,32.4 46.5,32.8 46.3C33.2 46.2,33.6 46.0,34.0 45.7C34.3 45.5,34.7 45.2,35.0 44.9C35.3 44.6,35.5 44.3,35.7 44.0C35.8 43.7,35.9 43.4,35.9 43.1C35.9 42.8,35.9 42.5,35.7 42.2C35.6 41.9,35.3 41.6,35.1 41.4C34.8 41.2,35.4 41.1,34.2 41.0C32.9 40.9,28.6 41.0,27.3 40.9C26.1 40.9,27.0 40.9,26.8 40.8C26.7 40.7,26.6 40.8,26.5 40.4C26.3 40.1,26.0 39.2,25.7 38.6C25.3 38.1,24.7 37.5,24.5 37.2C24.3 36.9,24.4 37.0,24.4 37.0C24.5 36.9,22.8 36.9,25.0 36.9C27.1 36.9,34.9 36.9,37.2 36.9C39.5 37.0,38.1 37.0,38.6 37.1C39.0 37.2,39.5 37.5,39.9 37.7C40.2 37.9,40.5 38.1,40.7 38.3C41.0 38.6,41.2 38.8,41.4 39.1C41.6 39.4,41.7 39.7,41.9 40.0C42.0 40.4,42.1 40.7,42.2 41.1C42.2 41.4,42.3 41.9,42.2 42.2C42.2 42.5,42.2 42.8,42.1 43.1C42.1 43.3,42.0 43.6,41.9 43.9C41.7 44.3,41.4 44.8,41.2 45.2C40.9 45.6,40.6 46.1,40.3 46.5C39.9 46.9,39.8 47.1,39.3 47.5C38.8 47.9,38.0 48.6,37.3 49.1C36.5 49.6,35.4 50.0,34.7 50.2C34.1 50.5,33.9 50.5,33.4 50.6C32.9 50.7,33.2 50.8,31.8 50.8C30.5 50.8,26.7 50.8,25.4 50.8C24.1 50.7,24.4 50.6,23.9 50.5C23.4 50.3,23.0 50.1,22.6 49.8C22.2 49.5,21.8 49.2,21.5 48.7C21.1 48.3,20.9 47.8,20.7 47.2C20.5 46.7,20.4 46.3,20.3 45.6C20.3 45.0,20.4 43.8,20.3 43.3C20.2 42.7,20.1 42.5,19.9 42.2C19.7 41.9,19.6 41.8,19.4 41.6C19.2 41.4,18.9 41.3,18.7 41.2C18.4 41.1,18.1 41.0,17.8 41.0C17.5 40.9,18.0 40.9,16.8 40.9C15.6 40.8,11.9 40.8,10.8 40.9C9.6 40.9,10.1 40.9,9.8 41.0C9.4 41.0,9.2 41.1,8.9 41.2C8.5 41.4,8.0 41.7,7.6 42.0C7.2 42.3,6.8 42.9,6.6 43.2C6.3 43.6,6.3 43.9,6.3 44.3C6.2 44.6,6.4 45.1,6.4 45.4C6.5 45.6,6.6 45.8,6.8 45.9C6.9 46.1,7.0 46.2,7.2 46.3C7.4 46.4,7.6 46.6,7.8 46.6C8.0 46.7,6.6 46.7,8.4 46.8C10.3 46.8,17.0 46.8,18.8 46.9C20.6 46.9,19.0 46.9,19.2 47.2C19.4 47.5,19.5 48.3,19.9 48.9C20.2 49.4,21.0 50.2,21.2 50.5C21.4 50.8,23.8 50.7,21.2 50.7C18.5 50.8,8.2 50.8,5.4 50.8C2.5 50.7,4.5 50.7,4.0 50.6C3.6 50.4,3.0 50.2,2.6 50.0C2.2 49.8,2.1 49.6,1.8 49.4C1.6 49.1,1.3 48.9,1.1 48.6C0.9 48.3,0.7 48.0,0.5 47.7C0.4 47.4,0.3 47.1,0.2 46.7C0.1 46.4,0.0 46.0,0.0 45.6C-0.0 45.3,0.0 44.9,0.1 44.6C0.1 44.2,0.2 43.9,0.3 43.6C0.4 43.2,0.6 42.9,0.8 42.6C0.9 42.2,1.2 41.8,1.4 41.4C1.7 41.1,2.0 40.7,2.5 40.2C3.0 39.7,3.9 39.0,4.4 38.6C5.0 38.2,5.2 38.1,5.6 37.9C6.0 37.7,6.5 37.5,6.9 37.4C7.4 37.2,7.8 37.1,8.2 37.0C8.6 37.0,9.3 36.9,9.5 36.9C9.8 36.8,7.9 36.9,9.6 36.9ZM42.0 37.0C42.2 37.0,39.5 36.9,42.8 36.9C46.0 36.9,58.1 37.0,61.4 37.0C64.7 37.1,62.3 37.2,62.7 37.3C63.1 37.4,63.5 37.6,63.7 37.7C64.0 37.9,64.2 38.0,64.4 38.3C64.7 38.5,64.9 39.1,65.1 39.2C65.3 39.4,65.0 39.6,65.4 39.4C65.9 39.2,67.3 38.3,67.8 38.0C68.4 37.7,68.4 37.8,68.8 37.7C69.2 37.6,69.5 37.5,70.3 37.4C71.1 37.3,71.2 37.3,73.6 37.3C76.0 37.2,82.7 37.3,84.6 37.3C86.4 37.4,84.9 37.4,84.9 37.5C84.9 37.6,85.2 37.5,84.7 37.9C84.2 38.3,82.7 39.5,82.1 39.9C81.5 40.3,81.5 40.3,81.2 40.3C80.9 40.4,81.7 40.5,80.1 40.5C78.6 40.5,73.4 40.4,71.8 40.5C70.2 40.5,71.0 40.6,70.8 40.7C70.5 40.8,70.3 41.0,70.2 41.1C70.1 41.2,70.1 41.3,70.1 41.4C70.2 41.5,70.1 41.6,70.3 41.7C70.4 41.8,70.0 42.0,71.0 42.1C72.0 42.2,74.9 42.2,76.1 42.3C77.4 42.4,77.9 42.5,78.5 42.7C79.1 42.9,79.4 43.1,79.8 43.4C80.1 43.7,80.4 44.3,80.6 44.5C80.8 44.7,80.8 44.7,80.9 44.7C81.1 44.7,80.4 45.5,81.4 44.5C82.4 43.4,85.9 39.7,87.0 38.6C88.1 37.5,87.8 38.0,88.1 37.8C88.5 37.6,88.7 37.5,89.0 37.4C89.4 37.4,89.1 37.3,90.2 37.3C91.3 37.3,94.5 37.3,95.5 37.4C96.5 37.4,96.0 37.5,96.2 37.7C96.4 37.9,96.0 36.3,96.6 38.4C97.1 40.4,99.2 47.8,99.7 49.8C100.2 51.8,99.8 50.1,99.7 50.3C99.7 50.4,99.7 50.5,99.6 50.6C99.5 50.7,99.4 50.7,99.3 50.8C99.1 50.8,99.4 50.9,98.7 50.9C98.1 50.9,96.2 50.9,95.5 50.9C94.9 50.9,95.1 50.9,94.9 50.8C94.6 50.7,94.4 50.6,94.2 50.3C93.9 50.0,93.8 49.2,93.5 48.9C93.3 48.6,94.0 48.6,92.6 48.5C91.2 48.4,86.5 48.5,85.2 48.5C83.8 48.4,84.6 48.3,84.5 48.3C84.4 48.2,84.4 48.2,84.5 48.1C84.5 48.0,84.4 48.1,84.7 47.8C85.1 47.4,86.2 46.4,86.6 46.0C87.0 45.7,86.9 45.7,87.2 45.6C87.5 45.5,87.6 45.5,88.4 45.4C89.1 45.4,91.0 45.5,91.7 45.4C92.4 45.3,92.3 45.2,92.4 45.1C92.6 44.9,92.7 45.1,92.6 44.4C92.4 43.7,91.9 41.7,91.7 41.0C91.5 40.4,91.5 40.6,91.4 40.5C91.3 40.4,91.3 40.3,91.1 40.3C91.0 40.4,92.2 39.1,90.5 40.6C88.9 42.2,82.9 47.9,81.2 49.5C79.4 51.1,80.5 50.1,80.2 50.2C79.9 50.4,79.8 50.5,79.3 50.6C78.8 50.7,79.3 50.8,77.3 50.9C75.2 50.9,68.9 50.9,66.9 50.9C65.0 50.9,65.9 50.8,65.5 50.8C65.1 50.7,64.9 50.7,64.6 50.5C64.3 50.4,64.1 50.3,63.6 49.9C63.2 49.5,62.2 48.5,61.8 48.2C61.5 47.8,61.6 47.9,61.6 47.8C61.6 47.7,61.7 47.7,61.8 47.6C62.0 47.6,60.6 47.5,62.5 47.5C64.4 47.5,71.3 47.5,73.3 47.5C75.3 47.4,74.3 47.2,74.5 47.1C74.8 47.0,74.8 46.9,74.9 46.8C74.9 46.7,75.0 46.6,75.0 46.4C74.9 46.3,74.9 46.0,74.7 45.9C74.5 45.8,74.9 45.7,73.9 45.6C72.9 45.5,69.8 45.5,68.6 45.4C67.4 45.3,67.3 45.3,66.9 45.2C66.4 45.0,66.1 44.9,65.7 44.7C65.3 44.4,64.9 43.9,64.7 43.7C64.5 43.6,64.5 43.6,64.4 43.6C64.2 43.6,64.3 43.5,64.0 43.7C63.8 43.9,63.3 44.5,62.9 44.8C62.5 45.2,62.1 45.4,61.7 45.7C61.3 45.9,60.9 46.1,60.4 46.2C59.9 46.4,59.1 46.5,58.7 46.7C58.4 46.8,58.4 46.8,58.4 46.9C58.4 47.1,58.0 46.9,58.6 47.4C59.3 48.0,61.5 49.8,62.1 50.3C62.7 50.8,62.2 50.5,62.3 50.6C62.3 50.6,62.3 50.7,62.2 50.7C62.1 50.8,62.1 50.8,61.6 50.9C61.1 50.9,60.2 50.9,59.3 50.9C58.5 50.8,57.0 50.8,56.3 50.7C55.7 50.6,55.9 50.6,55.6 50.5C55.4 50.4,55.8 50.8,54.8 50.0C53.9 49.3,50.8 46.8,49.8 46.0C48.8 45.2,49.2 45.4,49.0 45.2C48.9 45.0,48.9 44.9,48.9 44.8C48.8 44.6,48.8 44.5,48.9 44.4C48.9 44.3,49.0 44.1,49.2 44.0C49.4 43.9,48.6 43.9,49.8 43.8C51.0 43.8,55.1 43.9,56.5 43.8C57.8 43.8,57.6 43.7,58.0 43.6C58.4 43.5,58.6 43.4,58.8 43.2C59.0 43.0,59.2 42.8,59.4 42.5C59.5 42.3,59.6 42.0,59.6 41.8C59.6 41.6,59.6 41.3,59.5 41.1C59.3 40.9,59.2 40.8,58.9 40.7C58.6 40.5,59.3 40.5,57.8 40.4C56.4 40.4,51.6 40.4,50.1 40.4C48.6 40.4,49.3 40.5,49.0 40.6C48.7 40.7,49.4 39.5,48.3 41.1C47.2 42.8,43.6 48.8,42.5 50.4C41.5 52.0,42.2 50.6,42.0 50.7C41.8 50.8,42.0 50.8,41.3 50.9C40.6 50.9,38.5 50.8,37.9 50.8C37.3 50.8,37.7 50.8,37.7 50.7C37.7 50.7,37.4 50.9,37.8 50.6C38.2 50.3,39.3 49.7,40.0 49.2C40.6 48.6,41.2 48.0,41.7 47.4C42.3 46.8,42.7 46.2,43.0 45.6C43.4 45.0,43.7 44.3,43.9 43.7C44.1 43.1,44.1 42.6,44.1 42.0C44.1 41.4,44.0 40.7,43.9 40.2C43.8 39.7,43.6 39.3,43.3 38.8C43.0 38.3,42.3 37.6,42.1 37.3C41.9 37.0,42.0 37.0,42.0 37.0C42.0 36.9,41.9 37.0,42.0 37.0ZM25.2 56.2C25.7 56.2,27.7 56.1,28.1 56.3C28.5 56.5,27.9 57.4,27.8 57.6C27.7 57.8,28.1 57.7,27.6 57.7C27.1 57.7,25.6 57.6,24.9 57.6C24.3 57.7,24.0 57.8,23.7 58.0C23.4 58.1,23.2 58.4,23.0 58.6C22.8 58.7,22.8 58.9,22.7 59.1C22.6 59.3,22.5 59.6,22.4 59.8C22.4 60.1,22.4 60.4,22.4 60.6C22.5 60.8,22.5 61.0,22.7 61.1C22.9 61.3,22.8 61.4,23.5 61.5C24.1 61.6,26.1 61.3,26.6 61.5C27.0 61.7,26.3 62.5,26.3 62.7C26.2 62.9,26.5 62.8,26.1 62.9C25.6 62.9,24.3 63.0,23.7 63.0C23.0 62.9,22.5 62.9,22.1 62.7C21.7 62.6,21.3 62.4,21.1 62.2C20.8 61.9,20.7 61.6,20.6 61.3C20.5 61.0,20.6 60.7,20.6 60.4C20.6 60.2,20.7 59.8,20.8 59.5C20.9 59.2,21.0 58.9,21.1 58.7C21.3 58.4,21.5 58.0,21.7 57.8C21.9 57.5,22.1 57.4,22.3 57.2C22.6 57.0,22.9 56.8,23.2 56.7C23.5 56.6,23.7 56.5,24.0 56.4C24.3 56.3,25.0 56.3,25.2 56.2C25.4 56.2,24.7 56.2,25.2 56.2ZM67.8 56.2C68.3 56.2,70.2 56.3,70.8 56.3C71.3 56.3,71.0 56.2,70.9 56.4C70.9 56.7,71.1 57.4,70.5 57.6C69.9 57.8,68.0 57.5,67.3 57.6C66.7 57.6,66.8 57.6,66.6 57.7C66.4 57.8,66.2 57.9,66.1 58.0C66.0 58.1,66.0 58.3,66.0 58.4C66.1 58.5,65.8 58.5,66.3 58.7C66.8 58.8,68.5 59.2,69.1 59.4C69.6 59.6,69.5 59.6,69.7 59.8C69.8 60.0,69.9 60.2,70.0 60.4C70.0 60.7,69.9 61.1,69.7 61.4C69.6 61.7,69.3 62.0,69.1 62.2C68.8 62.4,68.5 62.5,68.1 62.7C67.7 62.8,67.4 62.9,66.6 62.9C65.8 63.0,63.9 62.9,63.3 62.9C62.8 62.9,63.2 62.9,63.1 62.9C63.1 62.8,63.0 62.9,63.1 62.7C63.1 62.5,62.9 61.8,63.5 61.6C64.1 61.4,66.2 61.6,66.9 61.6C67.5 61.6,67.4 61.6,67.6 61.5C67.8 61.4,68.0 61.3,68.1 61.2C68.2 61.1,68.2 61.0,68.2 60.9C68.1 60.8,68.5 60.7,68.0 60.6C67.4 60.4,65.6 60.0,65.0 59.8C64.4 59.6,64.6 59.5,64.4 59.4C64.3 59.2,64.2 59.0,64.2 58.8C64.2 58.5,64.3 58.1,64.5 57.8C64.6 57.4,64.9 57.2,65.2 57.0C65.4 56.7,65.8 56.6,66.2 56.5C66.6 56.4,67.5 56.3,67.8 56.2C68.1 56.2,67.4 56.2,67.8 56.2ZM31.9 56.3C32.2 56.3,33.3 55.3,33.8 56.4C34.3 57.4,35.0 61.8,34.9 62.8C34.9 63.9,33.6 63.0,33.3 62.8C33.0 62.7,33.1 62.0,33.1 61.8C33.0 61.6,33.5 61.7,32.9 61.7C32.3 61.6,30.2 61.5,29.4 61.7C28.7 61.9,28.9 62.6,28.5 62.8C28.1 63.0,26.3 63.9,26.8 62.8C27.4 61.7,31.1 57.4,31.9 56.3C32.8 55.2,31.6 56.3,31.9 56.3ZM37.8 56.3C38.5 56.3,41.5 56.3,42.4 56.3C43.4 56.4,43.1 56.4,43.4 56.5C43.6 56.7,43.8 56.8,43.9 56.9C44.0 57.1,44.0 57.2,44.1 57.4C44.1 57.5,44.2 57.6,44.1 57.9C44.0 58.2,43.8 58.9,43.6 59.3C43.5 59.7,43.2 59.9,42.9 60.1C42.6 60.3,41.9 60.2,41.8 60.7C41.7 61.1,42.6 62.5,42.4 62.8C42.2 63.2,41.0 63.1,40.6 62.8C40.3 62.5,40.2 61.3,40.1 61.0C40.0 60.6,40.2 60.9,39.9 60.8C39.6 60.8,38.5 60.5,38.1 60.9C37.7 61.2,37.8 62.5,37.4 62.8C37.1 63.1,35.8 63.9,35.8 62.8C35.9 61.7,37.4 57.4,37.7 56.3C38.1 55.2,37.0 56.3,37.8 56.3ZM45.3 56.3C45.6 56.3,46.4 56.3,46.7 56.3C47.0 56.3,46.9 55.8,47.0 56.4C47.1 57.1,47.2 59.7,47.3 60.4C47.4 61.1,46.9 61.3,47.4 60.7C47.9 60.0,49.8 57.1,50.3 56.4C50.9 55.7,50.4 56.3,50.6 56.3C50.9 56.3,51.7 56.3,51.9 56.3C52.1 56.4,52.0 55.9,52.0 56.6C52.1 57.2,52.2 59.8,52.3 60.5C52.4 61.2,51.9 61.4,52.4 60.7C52.9 60.0,54.8 57.1,55.3 56.4C55.9 55.7,55.4 56.3,55.7 56.3C56.0 56.3,57.5 55.3,57.0 56.3C56.5 57.4,53.7 61.7,52.7 62.8C51.8 63.9,51.5 62.9,51.2 62.9C50.9 62.9,51.1 63.4,51.0 62.7C50.9 62.0,50.7 59.4,50.6 58.7C50.5 58.1,51.0 57.9,50.5 58.6C50.0 59.2,48.1 62.0,47.6 62.7C47.1 63.5,47.6 62.8,47.3 62.9C47.0 62.9,46.2 63.2,45.9 62.8C45.6 62.4,45.7 61.6,45.6 60.5C45.5 59.4,45.4 57.0,45.3 56.4C45.3 55.7,45.1 56.4,45.3 56.3ZM59.4 56.3C59.7 56.3,60.7 55.3,61.2 56.4C61.7 57.4,62.5 61.8,62.4 62.8C62.3 63.9,61.1 63.0,60.8 62.8C60.4 62.7,60.6 62.0,60.5 61.8C60.5 61.6,61.0 61.7,60.4 61.7C59.8 61.6,57.6 61.5,56.9 61.7C56.2 61.9,56.4 62.6,56.0 62.8C55.5 63.0,53.7 63.9,54.3 62.8C54.9 61.7,58.5 57.4,59.4 56.3C60.2 55.2,59.1 56.3,59.4 56.3ZM72.3 56.3C72.6 56.3,73.7 56.0,73.9 56.4C74.0 56.8,73.3 58.3,73.2 58.7C73.2 59.1,72.9 58.9,73.4 58.9C74.0 58.9,76.0 59.3,76.7 58.9C77.3 58.4,77.1 56.8,77.5 56.4C77.9 55.9,79.1 55.3,79.1 56.4C79.0 57.4,77.8 61.7,77.2 62.8C76.6 63.9,75.8 63.2,75.6 62.8C75.5 62.4,76.2 60.9,76.3 60.4C76.4 60.0,76.7 60.3,76.1 60.3C75.5 60.2,73.5 59.9,72.8 60.3C72.1 60.7,72.4 62.4,72.0 62.8C71.6 63.2,70.3 63.9,70.4 62.8C70.5 61.7,72.0 57.4,72.3 56.3C72.7 55.3,72.1 56.3,72.3 56.3ZM42.2 58.6C42.2 58.5,42.3 58.2,42.2 58.0C42.1 57.9,42.2 57.8,41.7 57.7C41.1 57.6,39.5 57.7,39.0 57.7C38.5 57.7,39.0 57.5,38.9 57.8C38.8 58.1,38.1 59.4,38.4 59.7C38.8 60.0,40.7 59.7,41.3 59.6C41.9 59.5,41.8 59.3,42.0 59.2C42.1 59.0,42.2 58.8,42.2 58.7C42.2 58.6,42.2 58.7,42.2 58.6ZM30.4 60.5C30.8 60.5,32.5 60.9,32.8 60.5C33.2 60.1,32.5 58.4,32.4 58.0C32.3 57.6,32.6 57.5,32.3 57.9C31.9 58.3,30.7 60.0,30.4 60.5C30.1 60.9,30.0 60.5,30.4 60.5ZM57.8 60.5C58.2 60.5,59.9 60.9,60.3 60.5C60.6 60.1,60.2 57.9,59.8 57.9C59.4 57.9,58.2 60.0,57.8 60.5C57.5 60.9,57.4 60.5,57.8 60.5ZM39.0 57.7C39.5 57.8,41.3 57.7,41.9 57.8C42.4 57.9,42.2 58.0,42.2 58.2C42.2 58.4,42.1 58.8,42.0 59.0C42.0 59.2,41.8 59.3,41.7 59.4C41.5 59.5,41.6 59.6,41.1 59.6C40.5 59.7,38.8 59.9,38.5 59.6C38.1 59.3,38.9 58.1,39.0 57.8C39.1 57.5,38.5 57.7,39.0 57.7ZM32.4 57.9C32.4 58.4,32.7 60.0,32.8 60.4C32.9 60.8,33.1 60.5,32.7 60.5C32.3 60.5,30.5 60.9,30.4 60.5C30.4 60.0,32.0 58.4,32.3 57.9C32.7 57.5,32.3 57.5,32.4 57.9ZM59.8 57.9C59.9 58.4,60.2 59.9,60.3 60.4C60.3 60.8,60.6 60.5,60.2 60.5C59.8 60.5,57.9 60.9,57.9 60.5C57.8 60.0,59.5 58.4,59.8 57.9C60.1 57.5,59.7 57.5,59.8 57.9Z";

// src/lib/fiscal/qr.ts
import QRCode from "qrcode";
function qrSvg(texto, opts = {}) {
  const color = opts.color ?? "#000";
  const margen = opts.margen ?? 2;
  const { modules } = QRCode.create(texto, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const lado = n + margen * 2;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(y, x)) d += `M${x + margen} ${y + margen}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="C\xF3digo QR de verificaci\xF3n"><rect width="${lado}" height="${lado}" fill="#fff"/><path d="${d}" fill="${color}"/></svg>`;
}

// src/lib/fiscal/facturaDocument.ts
var TIPO_LABEL = {
  consumidor_final: "Factura de Consumidor Final",
  credito_fiscal: "Comprobante de Cr\xE9dito Fiscal",
  nota_credito: "Nota de Cr\xE9dito",
  nota_debito: "Nota de D\xE9bito"
};
var TIPO_DTE_LABEL = {
  "01": "Factura de Consumidor Final",
  "03": "Comprobante de Cr\xE9dito Fiscal",
  "05": "Nota de Cr\xE9dito",
  "06": "Nota de D\xE9bito",
  "14": "Factura de Sujeto Excluido"
};
function esc(value) {
  if (value == null) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function money(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}
function campoDte(label, value, clase = "") {
  return `<div class="id-field ${clase}">
    <div class="label">${esc(label)}</div>
    <div class="id-value ${value ? "mono" : "pending"}">${value ? esc(value) : "Pendiente de transmisi\xF3n"}</div>
  </div>`;
}
function campoOp(label, value, clase = "") {
  return `<div class="id-field ${clase}">
    <div class="label">${esc(label)}</div>
    <div class="id-value">${value ? esc(value) : "\u2014"}</div>
  </div>`;
}
function fila(label, value, opts = {}) {
  if (!value && !opts.requerido) return "";
  return `<div class="k">${esc(label)}</div>
    <div class="v${opts.mono && value ? " mono" : ""}${value ? "" : " missing"}">${value ? esc(value) : "No registrado"}</div>`;
}
function buildFacturaHTML(sale, emisor, dte = null) {
  const tipo = (dte && TIPO_DTE_LABEL[dte.tipoDte]) ?? TIPO_LABEL[sale.invoice_type ?? ""] ?? "Documento de venta";
  const esCcf = dte ? dte.tipoDte === "03" : sale.invoice_type === "credito_fiscal";
  const emitido = Boolean(dte?.numeroControl);
  const pruebas = dte?.ambiente === "00";
  const invalidado = dte?.estado === "INVALIDATED";
  const subtotal = Number(sale.subtotal || 0);
  const iva = Number(sale.tax_total || 0);
  const total = Number(sale.total || 0);
  const dep = sale.customer_departamento ? findDepartamento(sale.customer_departamento) : void 0;
  const mun = sale.customer_departamento && sale.customer_municipio ? findMunicipio(sale.customer_departamento, sale.customer_municipio) : void 0;
  const direccionReceptor = [sale.customer_direccion, mun?.nombre, dep?.nombre].filter(Boolean).join(", ");
  const fecha2 = dte?.fechaEmision ? `${dte.fechaEmision.split("-").reverse().join("/")}${dte.horaEmision ? ` ${dte.horaEmision}` : ""}` : formatearFechaHora(sale.created_at, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const lineas = sale.items?.length ? sale.items.map((i) => ({ desc: i.descripcion, cantidad: i.cantidad, unitario: i.unitario, total: i.total })) : [{ desc: sale.service_name ?? "Servicio de lavado", cantidad: 1, unitario: total, total }];
  const logo = `<svg class="logo" viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#FFFFFF" fill-rule="evenodd"/></svg>`;
  const aviso2 = !emitido ? `<div class="notice notice-danger">
         <strong>Documento no transmitido al Ministerio de Hacienda.</strong>
         Sin validez fiscal hasta obtener el sello de recepci\xF3n.
       </div>` : invalidado ? `<div class="notice notice-danger"><strong>Documento invalidado ante el Ministerio de Hacienda.</strong>
           Se conserva como constancia; ya no respalda la operaci\xF3n.</div>` : pruebas ? `<div class="notice notice-warning"><strong>Ambiente de pruebas.</strong>
             Emitido contra el sandbox del MH; no tiene validez fiscal.</div>` : "";
  const actividadEmisor = emisor.descActividad ? `${emisor.descActividad}${emisor.codActividad ? ` (${emisor.codActividad})` : ""}` : void 0;
  const emisorCard = `
      <div class="party">
        <div class="party-head">Emisor</div>
        <div class="party-name">${esc(emisor.razonSocial ?? emisor.nombreComercial)}</div>
        <div class="kv">
          ${fila("Nombre comercial", emisor.nombreComercial, { requerido: true })}
          ${fila("NIT", emisor.nit, { mono: true, requerido: true })}
          ${fila("NRC", emisor.nrc, { mono: true, requerido: true })}
          ${fila("Actividad econ\xF3mica", actividadEmisor, { requerido: true })}
          ${fila("Direcci\xF3n", emisor.direccion, { requerido: true })}
          ${fila("Tel\xE9fono", emisor.telefono)}
          ${fila("Correo", emisor.correo, { requerido: true })}
        </div>
      </div>`;
  const actividadReceptor = sale.customer_desc_actividad ? `${sale.customer_desc_actividad}${sale.customer_cod_actividad ? ` (${sale.customer_cod_actividad})` : ""}` : void 0;
  const receptorCard = `
      <div class="party">
        <div class="party-head">Receptor</div>
        <div class="party-name">${esc(sale.customer_name || "Consumidor final")}</div>
        <div class="kv">
          ${sale.customer_trade_name && sale.customer_trade_name !== sale.customer_name ? fila("Nombre comercial", sale.customer_trade_name) : ""}
          ${esCcf ? fila("NIT", sale.customer_nit, { mono: true, requerido: true }) : sale.customer_nit ? fila("NIT", sale.customer_nit, { mono: true }) : fila("DUI", sale.customer_dui, { mono: true })}
          ${fila("NRC", sale.customer_nrc, { mono: true, requerido: esCcf })}
          ${fila("Actividad econ\xF3mica", actividadReceptor, { requerido: esCcf })}
          ${fila("Direcci\xF3n", direccionReceptor, { requerido: esCcf })}
          ${fila("Tel\xE9fono", sale.customer_phone)}
          ${fila("Correo", sale.customer_email)}
        </div>
      </div>`;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>${esc(dte?.numeroControl || sale.invoice_number || sale.order_number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  :root {
    --ink: #16191A;
    --lime: #DFF56B;
    --sage: #EFF2EC;
    --sage-strong: #E9EEE4;
    --border: #DCE2D6;
    --muted: #5F6964;
    --danger: #B03A33;
    --danger-tint: #FBE9E7;
    --warning: #8A6414;
    --warning-tint: #FBF1DC;
  }
  /* M\xE1rgenes de 10 mm: lo que casi toda impresora de oficina garantiza sin
     recortar. M\xE1s que eso es papel en blanco. */
  @page { size: letter; margin: 10mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; background: #fff; color: var(--ink);
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5px; line-height: 1.4;
  }
  .sheet { max-width: 196mm; margin: 0 auto; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .label {
    font-size: 7px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 1px;
  }
  section, .party, .grand, tr { break-inside: avoid; page-break-inside: avoid; }

  /* \u2500\u2500 Cabecera: s\xF3lo marca, raz\xF3n social y tipo de documento \u2500\u2500 */
  .masthead {
    display: flex; justify-content: space-between; align-items: center; gap: 14px;
    background: var(--ink); color: #fff; border-radius: 12px; padding: 10px 16px;
  }
  .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .logo { width: 24mm; height: auto; display: block; flex-shrink: 0; }
  .issuer-name {
    font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 700;
    border-left: 1px solid rgba(255,255,255,0.22); padding-left: 14px;
  }
  .doc-head { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .doc-kicker { font-size: 7px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.62); }
  .doc-type {
    background: var(--lime); color: var(--ink);
    font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 12px;
    padding: 4px 12px; border-radius: 999px; white-space: nowrap;
  }

  .notice { margin-top: 6px; padding: 5px 10px; border-radius: 8px; font-size: 8.5px; }
  .notice strong { margin-right: 4px; }
  .notice-danger { background: var(--danger-tint); color: var(--danger); border: 1px solid var(--danger); }
  .notice-warning { background: var(--warning-tint); color: var(--warning); border: 1px solid var(--warning); }

  /* \u2500\u2500 Identificaci\xF3n del DTE y de la operaci\xF3n + QR \u2500\u2500 */
  .ident { display: flex; gap: 8px; margin-top: 8px; }
  .id-card {
    flex: 1; background: var(--sage); border-radius: 12px; padding: 9px 12px;
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; align-content: start;
  }
  .id-field { min-width: 0; }
  .id-field.c2 { grid-column: span 2; }
  .id-field.c4 { grid-column: 1 / -1; }
  .id-sep { grid-column: 1 / -1; border-top: 1px solid var(--border); }
  .id-value { font-size: 9.5px; font-weight: 600; word-break: break-all; }
  .id-value.pending { color: var(--danger); font-style: italic; font-weight: 500; }
  .qr-card {
    width: 36mm; flex-shrink: 0; border: 1px solid var(--border); border-radius: 12px;
    padding: 7px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .qr-card svg { width: 27mm; height: 27mm; display: block; }
  .qr-note { font-size: 7px; color: var(--muted); margin-top: 4px; line-height: 1.35; }
  .qr-note strong { color: var(--ink); }
  .qr-placeholder {
    width: 27mm; height: 27mm; border: 1.5px dashed var(--border); border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 7.5px; color: var(--muted); padding: 5px; line-height: 1.35;
  }

  /* \u2500\u2500 Emisor y receptor \u2500\u2500 */
  .parties { display: flex; gap: 8px; margin-top: 8px; }
  .party { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 12px; padding: 9px 12px; }
  .party-head {
    display: inline-block; font-size: 7px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;
    background: var(--ink); color: var(--lime); padding: 2px 8px; border-radius: 999px; margin-bottom: 5px;
  }
  .party-name { font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 700; margin-bottom: 4px; line-height: 1.2; }
  /* Etiqueta y valor en dos columnas: se lee como formulario y entra m\xE1s
     por cent\xEDmetro que una l\xEDnea por dato con la etiqueta delante. */
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 9px; }
  .kv .k { color: var(--muted); white-space: nowrap; }
  .kv .v { font-weight: 500; word-break: break-word; }
  .kv .v.missing { color: var(--danger); font-style: italic; }

  /* \u2500\u2500 Detalle \u2500\u2500 */
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th {
    font-size: 7px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); text-align: left; padding: 0 8px 5px;
    border-bottom: 1.5px solid var(--ink);
  }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 9.5px; }
  td.desc { font-weight: 500; }

  /* \u2500\u2500 Totales \u2500\u2500 */
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 8px; }
  .summary-note { font-size: 7.5px; color: var(--muted); max-width: 100mm; line-height: 1.45; }
  .totals { width: 72mm; }
  .totals-row { display: flex; justify-content: space-between; padding: 2px 10px; font-size: 9.5px; }
  .totals-row span:first-child { color: var(--muted); }
  .grand {
    display: flex; justify-content: space-between; align-items: center;
    background: var(--ink); color: #fff; border-radius: 10px;
    padding: 6px 12px; margin-top: 4px;
  }
  .grand-label { font-size: 7.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.7); }
  .grand-value { font-family: 'Outfit', sans-serif; font-size: 17px; font-weight: 800; color: var(--lime); font-variant-numeric: tabular-nums; }

  footer {
    margin-top: 12px; padding-top: 6px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 12px;
    font-size: 7.5px; color: var(--muted);
  }

  @media screen {
    body { background: var(--sage-strong); padding: 24px 0; }
    .sheet { background: #fff; padding: 10mm; border-radius: 6px; box-shadow: 0 12px 34px rgba(16,25,18,0.10); }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header class="masthead">
      <div class="brand">
        ${logo}
        <div class="issuer-name">${esc(emisor.razonSocial ?? emisor.nombreComercial)}</div>
      </div>
      <div class="doc-head">
        <div class="doc-kicker">Documento tributario electr\xF3nico</div>
        <div class="doc-type">${esc(tipo)}</div>
      </div>
    </header>

    ${aviso2}

    <section class="ident">
      <div class="id-card">
        ${campoDte("N\xFAmero de control", dte?.numeroControl, "c2")}
        ${campoDte("C\xF3digo de generaci\xF3n", dte?.codigoGeneracion, "c2")}
        ${campoDte("Sello de recepci\xF3n", dte?.selloRecepcion, "c2")}
        ${campoOp("Fecha y hora de emisi\xF3n", fecha2)}
        ${campoOp("Ambiente", !dte ? null : pruebas ? "Pruebas (00)" : "Producci\xF3n (01)")}
        <div class="id-sep"></div>
        ${campoOp("Orden", sale.order_number)}
        ${campoOp("Sucursal", sale.branch_name)}
        ${campoOp("Veh\xEDculo", sale.plate)}
        ${campoOp("Forma de pago", sale.payment_method)}
      </div>
      <div class="qr-card">
        ${dte?.qrUrl ? `${qrSvg(dte.qrUrl, { color: "#16191A", margen: 0 })}
             <div class="qr-note">Verific\xE1 en<br/><strong>admin.factura.gob.sv</strong></div>` : `<div class="qr-placeholder">El QR de verificaci\xF3n aparece cuando el MH sella el documento</div>`}
      </div>
    </section>

    <section class="parties">
      ${emisorCard}
      ${receptorCard}
    </section>

    <table>
      <thead>
        <tr><th style="width:58%">Descripci\xF3n</th><th class="num">Cant.</th><th class="num">Precio unitario</th><th class="num">Ventas gravadas</th></tr>
      </thead>
      <tbody>
        ${lineas.map((l) => `<tr>
          <td class="desc">${esc(l.desc)}</td>
          <td class="num">${esc(l.cantidad)}</td>
          <td class="num">${money(l.unitario)}</td>
          <td class="num">${money(l.total)}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <section class="summary">
      <div class="summary-note">
        Precios en d\xF3lares de los Estados Unidos de Am\xE9rica (USD).
        ${emitido ? "Esta es la representaci\xF3n gr\xE1fica de un documento tributario electr\xF3nico; el documento v\xE1lido es el registrado en el Ministerio de Hacienda." : ""}
      </div>
      <div class="totals">
        <div class="totals-row"><span>Subtotal sin IVA</span><span class="num">${money(subtotal)}</span></div>
        <div class="totals-row"><span>IVA 13%</span><span class="num">${money(iva)}</span></div>
        <div class="grand"><span class="grand-label">Total a pagar</span><span class="grand-value">${money(total)}</span></div>
      </div>
    </section>

    <footer>
      <span>${esc(emisor.razonSocial ?? emisor.nombreComercial)} \xB7 CORSA Carwash</span>
      <span>Generado el ${(/* @__PURE__ */ new Date()).toLocaleDateString("es-SV")}</span>
    </footer>
  </div>
  <script>
    // Se imprime cuando las fuentes terminaron de cargar: si no, el di\xE1logo
    // agarra la p\xE1gina con la fuente de reserva y el PDF sale con otra letra.
    if (!new URLSearchParams(location.search).get('noprint')) {
      window.addEventListener('load', function () {
        var listo = (document.fonts && document.fonts.ready) || Promise.resolve();
        var tope = new Promise(function (r) { setTimeout(r, 2500); });
        Promise.race([listo, tope]).then(function () {
          setTimeout(function () { window.focus(); window.print(); }, 150);
        });
      });
    }
  </script>
</body>
</html>`;
}

// src/lib/cxc/estadoCuenta.ts
var esc2 = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var money2 = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
var fecha = (iso) => iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("es-SV", { day: "2-digit", month: "short", year: "numeric" }) : "\u2014";
function diasVencido(due) {
  const hoy = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/El_Salvador" }));
  hoy.setHours(12, 0, 0, 0);
  const v = /* @__PURE__ */ new Date(`${due}T12:00:00`);
  return Math.round((hoy.getTime() - v.getTime()) / 864e5);
}
function estadoCuentaHTML(args) {
  const { emisor: e, cliente: c, documentos } = args;
  const lavados = args.lavados ?? [];
  const corte = (/* @__PURE__ */ new Date()).toLocaleDateString("es-SV", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/El_Salvador" });
  const emitidos = Object.values(documentos.filter((d) => d.balance > 0 && d.factura).reduce((acc, d) => {
    const k = d.factura;
    const g = acc[k] ??= { factura: k, created_at: d.created_at, due_date: d.due_date, amount: 0, balance: 0 };
    g.amount += d.amount;
    g.balance += d.balance;
    if (d.due_date < g.due_date) g.due_date = d.due_date;
    if (d.created_at < g.created_at) g.created_at = d.created_at;
    return acc;
  }, {})).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const pendientes = lavados.filter((l) => !l.consolidated_invoice_id);
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:150px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#16191A" fill-rule="evenodd"/></svg>`;
  const tramos = [
    ["Por vencer", c.por_vencer],
    ["1\u201330 d\xEDas", c.vencido_1_30],
    ["31\u201360 d\xEDas", c.vencido_31_60],
    ["61\u201390 d\xEDas", c.vencido_61_90],
    ["M\xE1s de 90", c.vencido_90_mas]
  ];
  const filasDocs = emitidos.map((d) => {
    const dias = diasVencido(d.due_date);
    return `<tr>
          <td>${esc2(d.factura)}</td>
          <td>${fecha(d.created_at)}</td>
          <td>${fecha(d.due_date)}</td>
          <td class="num">${money2(d.amount)}</td>
          <td class="num">${money2(d.amount - d.balance)}</td>
          <td class="num fuerte">${money2(d.balance)}</td>
          <td class="num ${dias > 0 ? "rojo" : ""}">${dias > 0 ? `${dias} d\xEDas` : "Al d\xEDa"}</td>
        </tr>`;
  }).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Estado de cuenta \xB7 ${esc2(c.customer_name ?? "")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Inter, Arial, sans-serif; color: #16191A; font-size: 11.5px; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #16191A; padding-bottom: 12px; }
  .emisor { text-align: right; font-size: 10.5px; line-height: 1.45; color: #3D4441; }
  .emisor b { color: #16191A; font-size: 11.5px; }
  h1 { font-family: Outfit, Arial; font-weight: 800; font-size: 26px; margin: 18px 0 2px; letter-spacing: -0.01em; }
  .corte { color: #5E6661; font-size: 11px; }
  .raya { display: inline-block; width: 46px; height: 5px; background: #DFF56B; border-radius: 3px; margin-top: 8px; }
  .bloques { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; margin-top: 16px; }
  .caja { border: 1px solid #DCE2D6; border-radius: 12px; padding: 12px 14px; }
  .caja h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #5E6661; }
  .kv { display: flex; justify-content: space-between; padding: 2px 0; }
  .kv span:first-child { color: #5E6661; }
  .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .cifra { background: #F3F5F0; border-radius: 12px; padding: 10px 12px; }
  .cifra small { display: block; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; font-weight: 700; }
  .cifra b { font-family: Outfit, Arial; font-size: 19px; }
  .cifra.tinta { background: #16191A; color: #fff; } .cifra.tinta small { color: #DFF56B; }
  .cifra.roja b { color: #C2272D; }
  h2 { font-family: Outfit, Arial; font-size: 15px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; border-bottom: 2px solid #16191A; padding: 6px 6px; }
  td { padding: 6px 6px; border-bottom: 1px solid #E3E8DE; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fuerte { font-weight: 700; } .rojo { color: #C2272D; font-weight: 700; }
  .vacio { text-align: center; color: #7A827D; padding: 14px; }
  .tramos td { text-align: center; } .tramos th { text-align: center; }
  .pie { margin-top: 22px; font-size: 10px; color: #5E6661; border-top: 1px solid #DCE2D6; padding-top: 10px; line-height: 1.5; }
</style></head><body>
  <div class="top">
    ${logo}
    <div class="emisor">
      <b>${esc2(e.razonSocial || e.nombreComercial)}</b><br/>
      ${e.nit ? `NIT ${esc2(e.nit)}` : ""}${e.nit && e.nrc ? " \xB7 " : ""}${e.nrc ? `NRC ${esc2(e.nrc)}` : ""}<br/>
      ${esc2(e.direccion ?? "")}<br/>
      ${e.telefono ? `Tel. ${esc2(e.telefono)}` : ""}${e.correo ? ` \xB7 ${esc2(e.correo)}` : ""}
    </div>
  </div>

  <h1>Estado de cuenta</h1>
  <div class="corte">Fecha de corte: ${esc2(corte)}</div>
  <div class="raya"></div>

  <div class="bloques">
    <div class="caja">
      <h3>Cliente</h3>
      <div style="font-weight:700;font-size:13px">${esc2(c.legal_name || c.customer_name || "")}</div>
      ${c.legal_name && c.customer_name && c.legal_name !== c.customer_name ? `<div>${esc2(c.customer_name)}</div>` : ""}
      ${c.nit ? `<div class="kv"><span>NIT</span><span>${esc2(c.nit)}</span></div>` : ""}
      ${c.phone ? `<div class="kv"><span>Tel\xE9fono</span><span>${esc2(c.phone)}</span></div>` : ""}
      ${c.email ? `<div class="kv"><span>Correo</span><span>${esc2(c.email)}</span></div>` : ""}
    </div>
    <div class="caja">
      <h3>Cr\xE9dito</h3>
      <div class="kv"><span>L\xEDmite de cr\xE9dito</span><b>${money2(c.credit_limit)}</b></div>
      <div class="kv"><span>Plazo</span><b>${c.credit_days} d\xEDas</b></div>
      <div class="kv"><span>Disponible</span><b>${money2(c.disponible)}</b></div>
      <div class="kv"><span>Lavados por facturar</span><b>${pendientes.length}</b></div>
    </div>
  </div>

  <div class="resumen">
    <div class="cifra tinta"><small>Saldo total</small><b>${money2(c.saldo)}</b></div>
    <div class="cifra"><small>Por vencer</small><b>${money2(c.por_vencer)}</b></div>
    <div class="cifra ${c.vencido > 0 ? "roja" : ""}"><small>Vencido</small><b>${money2(c.vencido)}</b></div>
    <div class="cifra"><small>Disponible</small><b>${money2(c.disponible)}</b></div>
  </div>

  <h2>Antig\xFCedad del saldo</h2>
  <table class="tramos"><tr>${tramos.map(([t]) => `<th>${t}</th>`).join("")}</tr>
    <tr>${tramos.map(([, v]) => `<td class="num" style="text-align:center">${money2(v)}</td>`).join("")}</tr></table>

  ${emitidos.length ? `
  <h2>Documentos emitidos pendientes de pago</h2>
  <table>
    <tr><th>Documento</th><th>Fecha</th><th>Vence</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Saldo</th><th class="num">Atraso</th></tr>
    ${filasDocs}
  </table>` : ""}

  ${pendientes.length ? `
  <h2>Lavados pendientes de facturar (${pendientes.length})</h2>
  <table>
    <tr><th>Fecha</th><th>Placa</th><th>Servicio</th><th class="num">Monto</th></tr>
    ${pendientes.slice(0, 150).map((l) => `<tr>
      <td>${fecha(l.created_at)}</td>
      <td style="font-weight:700">${esc2(l.placa_principal)}</td>
      <td>${esc2(l.detalle ?? "")}</td>
      <td class="num">${money2(l.total)}</td>
    </tr>`).join("")}
    <tr><td colspan="3" class="fuerte">Total por facturar</td><td class="num fuerte">${money2(pendientes.reduce((t, l) => t + l.total, 0))}</td></tr>
  </table>` : ""}

  <div class="pie">
    Este estado de cuenta resume las ventas al cr\xE9dito y los abonos registrados hasta la fecha de corte.
    Si encontr\xE1s alguna diferencia, comunicate con nosotros${e.telefono ? ` al ${esc2(e.telefono)}` : ""}${e.correo ? ` o a ${esc2(e.correo)}` : ""}.
    No es un documento tributario: las facturas de cada venta son los DTE emitidos ante el Ministerio de Hacienda.
  </div>
</body></html>`;
}

// src/lib/caja/reporteCierre.ts
var esc3 = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var money3 = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
var fechaHora = (iso) => iso ? new Date(iso).toLocaleString("es-SV", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/El_Salvador" }) : "\u2014";
var hora = (iso) => new Date(iso).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit", timeZone: "America/El_Salvador" });
function diaDelTurno(iso) {
  return new Date(iso).toLocaleDateString("es-SV", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/El_Salvador" });
}
function reporteCierreHTML(args) {
  const { emisor: e, resumen: r } = args;
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:150px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#16191A" fill-rule="evenodd"/></svg>`;
  const abierta = r.estado === "open";
  const retiros = r.movimientos.filter((m) => m.tipo === "cash_out");
  const filasRetiros = retiros.length === 0 ? `<tr><td colspan="5" class="vacio">Sin retiros de efectivo.</td></tr>` : retiros.map((m) => `<tr>
        <td>${esc3(hora(m.fecha))}</td>
        <td>${esc3(m.motivo)}</td>
        <td>${esc3(m.registro)}</td>
        <td>${esc3(m.autorizo ?? "\u2014")}</td>
        <td class="num fuerte">${money3(m.monto)}</td>
      </tr>`).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Cierre de caja \xB7 ${esc3(r.sucursal)} \xB7 ${esc3(diaDelTurno(r.abierta_at))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Inter, Arial, sans-serif; color: #16191A; font-size: 11.5px; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #16191A; padding-bottom: 12px; }
  .emisor { text-align: right; font-size: 10.5px; line-height: 1.45; color: #3D4441; }
  .emisor b { color: #16191A; font-size: 11.5px; }
  h1 { font-family: Outfit, Arial; font-weight: 800; font-size: 26px; margin: 18px 0 2px; letter-spacing: -0.01em; }
  .sub { color: #5E6661; font-size: 11px; text-transform: capitalize; }
  .raya { display: inline-block; width: 46px; height: 5px; background: #2F6B4F; border-radius: 3px; margin-top: 8px; }
  .abierta { display: inline-block; margin-left: 8px; font-size: 10px; font-weight: 700; color: #8A6414; background: #FBF1DC; padding: 2px 8px; border-radius: 99px; vertical-align: middle; }
  .bloques { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
  .caja { border: 1px solid #DCE2D6; border-radius: 12px; padding: 12px 14px; }
  .caja h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #5E6661; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; }
  .kv span:first-child { color: #5E6661; }
  .kv.total { border-top: 1px solid #DCE2D6; margin-top: 4px; padding-top: 6px; font-weight: 700; }
  .kv.total span:first-child { color: #16191A; }
  .menos { color: #C2272D; }
  .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .cifra { background: #F3F5F0; border-radius: 12px; padding: 10px 12px; }
  .cifra small { display: block; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; font-weight: 700; }
  .cifra b { font-family: Outfit, Arial; font-size: 19px; }
  .cifra.tinta { background: #16191A; color: #fff; } .cifra.tinta small { color: #DFF56B; }
  h2 { font-family: Outfit, Arial; font-size: 15px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; border-bottom: 2px solid #16191A; padding: 6px 6px; }
  td { padding: 6px 6px; border-bottom: 1px solid #E3E8DE; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fuerte { font-weight: 700; }
  .vacio { text-align: center; color: #7A827D; padding: 14px; }
  .firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 46px; }
  .firma { border-top: 1px solid #16191A; padding-top: 6px; text-align: center; font-size: 10.5px; color: #3D4441; }
  .pie { margin-top: 22px; font-size: 10px; color: #5E6661; border-top: 1px solid #DCE2D6; padding-top: 10px; line-height: 1.5; }
</style></head><body>
  <div class="top">
    ${logo}
    <div class="emisor">
      <b>${esc3(e.razonSocial || e.nombreComercial)}</b><br/>
      ${e.nit ? `NIT ${esc3(e.nit)}` : ""}${e.nit && e.nrc ? " \xB7 " : ""}${e.nrc ? `NRC ${esc3(e.nrc)}` : ""}<br/>
      ${esc3(r.sucursal)} \xB7 ${esc3(r.caja)}
    </div>
  </div>

  <h1>Cierre de caja${abierta ? '<span class="abierta">CAJA ABIERTA \xB7 PARCIAL</span>' : ""}</h1>
  <div class="sub">${esc3(diaDelTurno(r.abierta_at))}</div>
  <div class="raya"></div>

  <div class="resumen">
    <div class="cifra"><small>Efectivo inicial</small><b>${money3(r.efectivo_inicial)}</b></div>
    <div class="cifra"><small>Ventas del d\xEDa</small><b>${money3(r.ventas.total)}</b></div>
    <div class="cifra"><small>Remesa</small><b>${money3(r.remesa)}</b></div>
    <div class="cifra tinta"><small>${abierta ? "Efectivo en caja" : "Efectivo final"}</small><b>${money3(abierta ? r.efectivo_disponible : r.efectivo_final)}</b></div>
  </div>

  <div class="bloques">
    <div class="caja">
      <h3>Ventas por forma de pago</h3>
      <div class="kv"><span>Efectivo</span><b>${money3(r.ventas.efectivo)}</b></div>
      <div class="kv"><span>Tarjeta</span><b>${money3(r.ventas.tarjeta)}</b></div>
      <div class="kv"><span>Transferencia</span><b>${money3(r.ventas.transferencia)}</b></div>
      ${r.ventas.otros > 0 ? `<div class="kv"><span>Otros</span><b>${money3(r.ventas.otros)}</b></div>` : ""}
      <div class="kv total"><span>Total cobrado (${r.ventas.cantidad} ventas)</span><span>${money3(r.ventas.total)}</span></div>
    </div>
    <div class="caja">
      <h3>Movimiento del efectivo</h3>
      <div class="kv"><span>Efectivo inicial</span><b>${money3(r.efectivo_inicial)}</b></div>
      <div class="kv"><span>+ Ingresos en efectivo</span><b>${money3(r.ingresos_efectivo)}</b></div>
      <div class="kv"><span>\u2212 Retiros de efectivo</span><b class="menos">${money3(r.egresos_efectivo)}</b></div>
      <div class="kv"><span>= Efectivo antes de remesar</span><b>${money3(r.efectivo_disponible)}</b></div>
      <div class="kv"><span>\u2212 Remesa</span><b class="menos">${money3(r.remesa)}</b></div>
      <div class="kv total"><span>Efectivo final en caja</span><span>${money3(r.efectivo_final)}</span></div>
    </div>
  </div>

  <h2>Retiros de efectivo (${retiros.length})</h2>
  <table>
    <tr><th>Hora</th><th>Motivo</th><th>Registr\xF3</th><th>Autoriz\xF3</th><th class="num">Monto</th></tr>
    ${filasRetiros}
  </table>

  <div class="bloques">
    <div class="caja">
      <h3>Apertura</h3>
      <div class="kv"><span>Fecha y hora</span><span>${esc3(fechaHora(r.abierta_at))}</span></div>
      <div class="kv"><span>Abri\xF3</span><span>${esc3(r.abrio)}</span></div>
    </div>
    <div class="caja">
      <h3>Cierre</h3>
      <div class="kv"><span>Fecha y hora</span><span>${esc3(fechaHora(r.cerrada_at))}</span></div>
      <div class="kv"><span>Cerr\xF3</span><span>${esc3(r.cerro ?? "\u2014")}</span></div>
    </div>
  </div>

  <div class="firmas">
    <div class="firma">Cajero \xB7 ${esc3(r.cerro ?? r.abrio)}</div>
    <div class="firma">Recibe la remesa</div>
  </div>

  <div class="pie">
    Las ventas se toman de los cobros registrados en el POS entre la apertura y el cierre de la caja, por forma de pago.
    Las ventas al cr\xE9dito no entran en caja: van a cuentas por cobrar. Efectivo final = inicial + ingresos \u2212 retiros \u2212 remesa.
  </div>
</body></html>`;
}

// src/lib/caja/resumen.ts
var num = (v) => Number(v ?? 0) || 0;
function normalizarResumen(r) {
  return {
    ...r,
    efectivo_inicial: num(r.efectivo_inicial),
    ventas: {
      efectivo: num(r.ventas?.efectivo),
      tarjeta: num(r.ventas?.tarjeta),
      transferencia: num(r.ventas?.transferencia),
      otros: num(r.ventas?.otros),
      total: num(r.ventas?.total),
      cantidad: num(r.ventas?.cantidad)
    },
    ingresos_efectivo: num(r.ingresos_efectivo),
    egresos_efectivo: num(r.egresos_efectivo),
    remesa: num(r.remesa),
    efectivo_disponible: num(r.efectivo_disponible),
    efectivo_final: num(r.efectivo_final),
    movimientos: (r.movimientos ?? []).map((m) => ({ ...m, monto: num(m.monto) }))
  };
}

// server/correo/datos.ts
import { createClient } from "@supabase/supabase-js";

// src/lib/fiscal/consultaMh.ts
var CONSULTA_MH = "https://admin.factura.gob.sv/consultaPublica";
function urlConsultaMh(d) {
  const q = new URLSearchParams({
    ambiente: d.ambiente,
    codGen: d.codigoGeneracion,
    fechaEmi: d.fechaEmi
  });
  return `${CONSULTA_MH}?${q.toString()}`;
}

// server/correo/datos.ts
function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el servidor");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function usuarioDe(db, jwt) {
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw Object.assign(new Error("La sesi\xF3n venci\xF3. Volv\xE9 a ingresar."), { status: 401 });
  const { data: perfil } = await db.from("profiles").select("organization_id").eq("id", data.user.id).maybeSingle();
  if (!perfil?.organization_id) throw Object.assign(new Error("El usuario no pertenece a ninguna organizaci\xF3n"), { status: 403 });
  return { userId: data.user.id, orgId: perfil.organization_id };
}
var vacio = (v) => v == null || String(v).trim() === "";
var nit = (n) => {
  const d = n.replace(/\D/g, "");
  return d.length === 14 ? `${d.slice(0, 4)}-${d.slice(4, 10)}-${d.slice(10, 13)}-${d.slice(13)}` : n;
};
var nrc = (n) => {
  const d = n.replace(/\D/g, "");
  return d.length >= 2 ? `${d.slice(0, -1)}-${d.slice(-1)}` : n;
};
async function emisorDeSucursal(db, branchId) {
  const marca = { nombreComercial: "CORSA CARWASH" };
  if (!branchId) return marca;
  const { data: f } = await db.from("fiscal_issuer_config").select("nit, nrc, nombre, nombre_comercial, cod_actividad, desc_actividad, departamento, municipio, complemento, telefono, correo").eq("branch_id", branchId).eq("activo", true).maybeSingle();
  if (!f || vacio(f.nit) || vacio(f.nombre)) return marca;
  const dep = f.departamento ? findDepartamento(f.departamento) : void 0;
  const mun = dep && f.municipio ? findMunicipio(f.departamento, f.municipio) : void 0;
  return {
    nombreComercial: f.nombre_comercial || marca.nombreComercial,
    razonSocial: f.nombre,
    nit: nit(f.nit),
    nrc: f.nrc ? nrc(f.nrc) : void 0,
    direccion: [f.complemento, mun?.nombre, dep?.nombre].filter(Boolean).join(", "),
    telefono: f.telefono ?? void 0,
    correo: f.correo ?? void 0,
    codActividad: f.cod_actividad ?? void 0,
    descActividad: f.desc_actividad ?? void 0
  };
}
async function dteDeFactura(db, invoiceId) {
  const { data } = await db.from("fiscal_documents").select("id, dte_type, ambiente, status, numero_control, codigo_generacion, sello_recepcion, json_original, signed_jws, created_at").eq("invoice_id", invoiceId).not("numero_control", "is", null).order("created_at", { ascending: false });
  const filas = data ?? [];
  const d = filas.find((f) => f.status === "ACCEPTED") ?? filas.find((f) => f.status === "INVALIDATED") ?? filas[0];
  if (!d) return null;
  const ident = d.json_original?.identificacion ?? {};
  const sellado = Boolean(d.sello_recepcion) && (d.status === "ACCEPTED" || d.status === "INVALIDATED");
  return {
    id: d.id,
    dte: {
      tipoDte: d.dte_type,
      ambiente: d.ambiente,
      estado: d.status,
      numeroControl: d.numero_control,
      codigoGeneracion: d.codigo_generacion,
      selloRecepcion: d.sello_recepcion ?? null,
      fechaEmision: ident.fecEmi ?? null,
      horaEmision: ident.horEmi ?? null,
      qrUrl: sellado && ident.fecEmi ? urlConsultaMh({ ambiente: d.ambiente, codigoGeneracion: d.codigo_generacion, fechaEmi: ident.fecEmi }) : null
    },
    json: d.json_original && d.signed_jws ? { ...d.json_original, firmaElectronica: d.signed_jws, selloRecibido: d.sello_recepcion ?? null } : null
  };
}
async function ventaDeOrden(db, orderId, orgId) {
  const { data } = await db.from("v_sales_history").select("*").eq("order_id", orderId).eq("organization_id", orgId).maybeSingle();
  return data ?? null;
}
async function cliente(db, id, orgId) {
  if (!id) return null;
  const { data: c } = await db.from("customers").select("id, customer_type, first_name, last_name, trade_name, legal_name, nit, nrc, dui, email, billing_email, phone, cod_actividad, desc_actividad, fiscal_departamento, fiscal_municipio, fiscal_complemento").eq("id", id).eq("organization_id", orgId).maybeSingle();
  if (!c) return null;
  const nombre = c.customer_type === "company" ? c.legal_name || c.trade_name || "Cliente" : `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Cliente";
  return {
    id: c.id,
    nombre,
    customer_type: c.customer_type,
    correo: (c.billing_email || c.email || "").trim() || null,
    nit: c.nit,
    nrc: c.nrc,
    dui: c.dui,
    cod_actividad: c.cod_actividad,
    desc_actividad: c.desc_actividad,
    phone: c.phone,
    departamento: c.fiscal_departamento,
    municipio: c.fiscal_municipio,
    direccion: c.fiscal_complemento,
    trade_name: c.trade_name
  };
}
async function datosCxc(db, customerId, orgId) {
  const num2 = (r, ks) => {
    for (const k of ks) if (k in r) r[k] = Number(r[k] ?? 0);
    return r;
  };
  const [{ data: cta }, { data: docs }, { data: movs }, { data: lav }] = await Promise.all([
    db.from("v_cxc_clientes").select("*").eq("customer_id", customerId).eq("organization_id", orgId).maybeSingle(),
    db.from("accounts_receivable").select("id, created_at, due_date, amount, balance, status, work_orders(order_number), invoices(invoice_number)").eq("customer_id", customerId).eq("organization_id", orgId).neq("status", "void").order("due_date"),
    db.from("corporate_credit_events").select("id, created_at, event_type, amount, credit_limit, balance_after, reason").eq("customer_id", customerId).eq("organization_id", orgId).order("created_at", { ascending: false }).limit(100),
    db.from("v_lavados_credito").select("*").eq("customer_id", customerId).eq("organization_id", orgId).neq("status", "cancelled").order("created_at", { ascending: false }).limit(200)
  ]);
  return {
    cuenta: cta ? num2({ ...cta }, [
      "credit_limit",
      "credit_days",
      "saldo",
      "disponible",
      "por_vencer",
      "vencido",
      "vencido_1_30",
      "vencido_31_60",
      "vencido_61_90",
      "vencido_90_mas",
      "documentos_abiertos"
    ]) : null,
    documentos: (docs ?? []).map((r) => ({
      id: r.id,
      created_at: r.created_at,
      due_date: r.due_date,
      amount: Number(r.amount),
      balance: Number(r.balance),
      status: r.status,
      orden: r.work_orders?.order_number ?? null,
      factura: r.invoices?.invoice_number ?? null
    })),
    movimientos: (movs ?? []).map((m) => ({
      ...m,
      amount: m.amount != null ? Number(m.amount) : null,
      credit_limit: m.credit_limit != null ? Number(m.credit_limit) : null,
      balance_after: m.balance_after != null ? Number(m.balance_after) : null
    })),
    lavados: (lav ?? []).map((l) => ({ ...l, total: Number(l.total) }))
  };
}
async function registrarEnvio(db, fila3) {
  const { error } = await db.from("envios_correo").insert(fila3);
  if (error) console.error("[correo] no se pudo registrar el env\xEDo", error.message);
}

// server/correo/pdf.ts
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
async function abrirNavegador() {
  const local = process.env.CHROME_PATH;
  return puppeteer.launch({
    args: local ? ["--no-sandbox", "--disable-gpu"] : chromium.args,
    executablePath: local || await chromium.executablePath(),
    headless: true
  });
}
async function htmlAPdf(navegador, html) {
  const pagina = await navegador.newPage();
  try {
    await pagina.evaluateOnNewDocument("window._corsaPreview = true; window.print = function () {};");
    await pagina.setContent(html, { waitUntil: "load", timeout: 25e3 });
    await pagina.evaluate("document.fonts ? document.fonts.ready : null");
    const pdf = await pagina.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await pagina.close();
  }
}

// server/correo/plantillas.ts
var TINTA = "#16191A";
var LIMA = "#DFF56B";
var FONDO = "#EFF2EC";
var GRIS = "#5E6661";
var esc4 = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var money4 = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function fechaSV(iso, conHora = false) {
  return new Date(iso).toLocaleString("es-SV", {
    timeZone: "America/El_Salvador",
    day: "2-digit",
    month: "long",
    year: "numeric",
    ...conHora ? { hour: "2-digit", minute: "2-digit" } : {}
  });
}
function fila2(etiqueta, valor, fuerte = false) {
  return `<tr>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;color:${GRIS};font-size:13px">${esc4(etiqueta)}</td>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;text-align:right;font-size:13px;color:${TINTA};${fuerte ? "font-weight:700" : ""}">${valor}</td>
  </tr>`;
}
function tarjeta(titulo, filas) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;border:1px solid #E3E8DE;border-radius:14px">
    <tr><td style="padding:14px 18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GRIS};margin-bottom:4px">${esc4(titulo)}</div>
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
<title>${esc4(args.titulo)}</title></head>
<body style="margin:0;padding:0;background:${FONDO};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${TINTA}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc4(args.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${FONDO}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #E3E8DE">
      <tr><td style="background:${TINTA};padding:24px 28px 20px" align="left">
        <img src="${esc4(args.appUrl)}/marca/corsa-email.png" width="150" alt="CORSA Carwash" style="display:block;width:150px;height:auto;border:0"/>
        <div style="width:44px;height:4px;background:${LIMA};border-radius:2px;margin-top:14px"></div>
      </td></tr>
      <tr><td style="padding:26px 28px 8px">
        <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;font-weight:800;color:${TINTA}">${esc4(args.titulo)}</h1>
        ${args.cuerpo}
      </td></tr>
      <tr><td style="padding:18px 28px 24px;border-top:1px solid #EEF1EA;font-size:11.5px;line-height:1.55;color:${GRIS}">
        <strong style="color:${TINTA}">${esc4(e.nombreComercial || "CORSA Carwash")}</strong>${e.razonSocial ? ` \xB7 ${esc4(e.razonSocial)}` : ""}<br/>
        ${e.direccion ? `${esc4(e.direccion)}<br/>` : ""}
        ${[e.telefono ? `Tel. ${esc4(e.telefono)}` : "", e.correo ? esc4(e.correo) : ""].filter(Boolean).join(" \xB7 ")}
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
  return `<a href="${esc4(url)}" style="display:inline-block;background:${TINTA};color:${LIMA};text-decoration:none;font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:10px;margin:6px 0 4px">${esc4(texto)}</a>`;
}

// server/correo/handler.ts
var CORREO_CORSA = "corsacarwash@gmail.com";
var COPIA_TEMPORAL = ["pabloavilesjubis@gmail.com"];
var DESTINOS_CIERRE_CAJA = ["jubismauricio@gmail.com"];
var ErrorHttp = class extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
};
function destinos(correoCliente) {
  const to = correoCliente ? [correoCliente] : [CORREO_CORSA];
  const bcc = [...correoCliente ? [CORREO_CORSA] : [], ...COPIA_TEMPORAL];
  const vistos = new Set(to.map((t) => t.toLowerCase()));
  return { to, bcc: bcc.filter((b) => {
    const k = b.toLowerCase();
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }) };
}
function transporte() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new ErrorHttp(500, "El correo no est\xE1 configurado en el servidor (SMTP).");
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
var TIPO_DTE = {
  "01": "Factura electr\xF3nica",
  "03": "Comprobante de cr\xE9dito fiscal",
  "05": "Nota de cr\xE9dito",
  "14": "Factura de sujeto excluido"
};
function saludo(c) {
  if (!c) return "Hola";
  const nombre = c.customer_type === "company" ? c.trade_name || c.nombre : c.nombre.split(" ")[0];
  return `Hola, ${esc4(nombre)}`;
}
function serviciosDe(sale) {
  return (sale?.items ?? []).map((i) => String(i.descripcion).replace(/^Aspirado de interiores/, "Aspirado"));
}
async function enviarYRegistrar(args) {
  const { to, bcc } = args.destinos ?? destinos(args.correoCliente);
  try {
    const info = await transporte().sendMail({
      from: remitente(),
      to,
      bcc,
      subject: args.asunto,
      html: args.html,
      attachments: args.adjuntos.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
    });
    await registrarEnvio(args.db, {
      organization_id: args.orgId,
      tipo: args.tipo,
      work_order_id: args.workOrderId ?? null,
      invoice_id: args.invoiceId ?? null,
      fiscal_document_id: args.fiscalDocumentId ?? null,
      customer_id: args.customerId ?? null,
      cash_session_id: args.cashSessionId ?? null,
      destinatarios: to,
      bcc,
      asunto: args.asunto,
      status: "sent",
      message_id: info.messageId ?? null,
      created_by: args.userId
    });
    return { status: 200, body: { ok: true, estado: "sent", destinatarios: to } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await registrarEnvio(args.db, {
      organization_id: args.orgId,
      tipo: args.tipo,
      work_order_id: args.workOrderId ?? null,
      invoice_id: args.invoiceId ?? null,
      fiscal_document_id: args.fiscalDocumentId ?? null,
      customer_id: args.customerId ?? null,
      cash_session_id: args.cashSessionId ?? null,
      destinatarios: to,
      bcc,
      asunto: args.asunto,
      status: "failed",
      error: error.slice(0, 500),
      created_by: args.userId
    });
    return { status: 502, body: { ok: false, estado: "failed", error: `No se pudo enviar el correo: ${error}` } };
  }
}
async function correoDeVenta(db, orgId, userId, appUrl, workOrderId) {
  const { data: wo } = await db.from("work_orders").select("id, organization_id, branch_id, customer_id, status, facturacion_diferida, created_at, order_number").eq("id", workOrderId).eq("organization_id", orgId).maybeSingle();
  if (!wo) throw new ErrorHttp(404, "No existe esa venta");
  if (wo.status === "cancelled") throw new ErrorHttp(409, "La venta est\xE1 anulada");
  const sale = await ventaDeOrden(db, workOrderId, orgId);
  const { data: inv } = await db.from("invoices").select("id, receptor_customer_id, customer_id, status").eq("work_order_id", workOrderId).neq("status", "voided").maybeSingle();
  const doc = inv ? await dteDeFactura(db, inv.id) : null;
  const sellado = doc?.dte.estado === "ACCEPTED";
  const { count: deudas } = await db.from("accounts_receivable").select("id", { count: "exact", head: true }).eq("work_order_id", workOrderId);
  const alCredito = Boolean(wo.facturacion_diferida) || (deudas ?? 0) > 0;
  if (!alCredito && !sellado) {
    throw new ErrorHttp(409, "La venta todav\xEDa no tiene su DTE sellado por Hacienda: el correo sale cuando se sella.");
  }
  const emisor = await emisorDeSucursal(db, wo.branch_id);
  const navegador = await abrirNavegador();
  try {
    const adjuntos = [];
    if (sellado && sale && doc) {
      const nombre = doc.dte.numeroControl ?? `dte-${wo.order_number}`;
      adjuntos.push({ filename: `${nombre}.pdf`, content: await htmlAPdf(navegador, buildFacturaHTML(sale, emisor, doc.dte)), contentType: "application/pdf" });
      if (doc.json) adjuntos.push({ filename: `${nombre}.json`, content: JSON.stringify(doc.json, null, 2), contentType: "application/json" });
    }
    const placa = sale?.plate ?? "";
    const servicios = serviciosDe(sale);
    if (alCredito) {
      const c = await cliente(db, wo.customer_id, orgId);
      const cxc = await datosCxc(db, wo.customer_id, orgId);
      if (cxc.cuenta) {
        adjuntos.push({
          filename: `estado-de-cuenta-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.pdf`,
          content: await htmlAPdf(navegador, estadoCuentaHTML({ emisor, cliente: cxc.cuenta, documentos: cxc.documentos, movimientos: cxc.movimientos, lavados: cxc.lavados })),
          contentType: "application/pdf"
        });
      }
      const facturado = sellado && doc ? aviso(`<strong>Facturado.</strong> Este servicio va en tu ${esc4(TIPO_DTE[doc.dte.tipoDte] ?? "DTE")} <strong>${esc4(doc.dte.numeroControl)}</strong>, adjunto en PDF y JSON.`) : aviso("<strong>Pendiente de facturar.</strong> Este lavado qued\xF3 cargado a tu cuenta y se incluye en tu pr\xF3ximo CCF consolidado.", "ambar");
      const html2 = layout({
        appUrl,
        emisor,
        preheader: `Gracias por lavar tu carro ${placa} en CORSA.`,
        titulo: "\xA1Gracias por tu visita!",
        cuerpo: parrafo(`${saludo(c)}: gracias por confiar en CORSA Carwash. Hoy dejamos listo tu carro${placa ? ` placa <strong>${esc4(placa)}</strong>` : ""}.`) + tarjeta("Tu lavado", [
          fila2("Fecha", esc4(fechaSV(wo.created_at, true))),
          ...placa ? [fila2("Placa", `<strong>${esc4(placa)}</strong>`)] : [],
          fila2("Servicio", esc4(servicios.join(" + ") || "Lavado")),
          fila2("Total del servicio", money4(Number(sale?.total ?? 0)), true)
        ].join("")) + facturado + (cxc.cuenta ? tarjeta("Tu cuenta a la fecha", [
          fila2("Saldo acumulado", money4(cxc.cuenta.saldo), true),
          fila2("Por vencer", money4(cxc.cuenta.por_vencer)),
          ...cxc.cuenta.vencido > 0 ? [fila2("Vencido", `<span style="color:#C2272D;font-weight:700">${money4(cxc.cuenta.vencido)}</span>`)] : [],
          fila2("Cr\xE9dito disponible", money4(cxc.cuenta.disponible)),
          ...cxc.lavados.some((l) => !l.consolidated_invoice_id) ? [fila2("Lavados pendientes de facturar", String(cxc.lavados.filter((l) => !l.consolidated_invoice_id).length))] : []
        ].join("")) : "") + parrafo("Adjuntamos tu estado de cuenta con el historial de servicios. \xA1Te esperamos pronto!")
      });
      return enviarYRegistrar({
        db,
        orgId,
        userId,
        tipo: "lavado_credito",
        correoCliente: c?.correo ?? null,
        asunto: `Gracias por tu visita a CORSA${placa ? ` \xB7 ${placa}` : ""}`,
        html: html2,
        adjuntos,
        workOrderId,
        invoiceId: inv?.id ?? null,
        fiscalDocumentId: doc?.id ?? null,
        customerId: wo.customer_id
      });
    }
    const receptor = await cliente(db, inv?.receptor_customer_id ?? null, orgId);
    const tipo = TIPO_DTE[doc.dte.tipoDte] ?? "Documento tributario electr\xF3nico";
    const html = layout({
      appUrl,
      emisor,
      preheader: `${tipo} ${doc.dte.numeroControl} \xB7 ${money4(Number(sale?.total ?? 0))}`,
      titulo: `Tu ${tipo.toLowerCase()}`,
      cuerpo: parrafo(`${saludo(receptor)}: gracias por tu visita a CORSA Carwash. Adjuntamos tu documento tributario electr\xF3nico en PDF y su archivo JSON.`) + tarjeta("Documento", [
        fila2("Tipo", esc4(tipo)),
        fila2("N\xFAmero de control", `<span style="font-family:monospace">${esc4(doc.dte.numeroControl)}</span>`),
        fila2("C\xF3digo de generaci\xF3n", `<span style="font-family:monospace;font-size:11.5px">${esc4(doc.dte.codigoGeneracion)}</span>`),
        fila2("Fecha", esc4(fechaSV(wo.created_at, true))),
        ...placa ? [fila2("Placa", `<strong>${esc4(placa)}</strong>`)] : [],
        fila2("Servicio", esc4(servicios.join(" + ") || "Lavado")),
        fila2("Total", money4(Number(sale?.total ?? 0)), true)
      ].join("")) + (doc.dte.qrUrl ? parrafo(boton("Verificar en Hacienda", doc.dte.qrUrl)) : "")
    });
    return enviarYRegistrar({
      db,
      orgId,
      userId,
      tipo: "dte",
      correoCliente: receptor?.correo ?? null,
      asunto: `${tipo} CORSA Carwash \xB7 ${doc.dte.numeroControl}`,
      html,
      adjuntos,
      workOrderId,
      invoiceId: inv?.id ?? null,
      fiscalDocumentId: doc?.id ?? null,
      customerId: receptor?.id ?? null
    });
  } finally {
    await navegador.close();
  }
}
async function correoDeFactura(db, orgId, userId, appUrl, invoiceId) {
  const { data: inv } = await db.from("invoices").select("id, organization_id, branch_id, work_order_id, customer_id, receptor_customer_id, invoice_type, invoice_number, subtotal, tax_amount, total, consolidado, created_at, status").eq("id", invoiceId).eq("organization_id", orgId).maybeSingle();
  if (!inv) throw new ErrorHttp(404, "No existe esa factura");
  if (!inv.consolidado && inv.work_order_id) return correoDeVenta(db, orgId, userId, appUrl, inv.work_order_id);
  const doc = await dteDeFactura(db, invoiceId);
  if (doc?.dte.estado !== "ACCEPTED") throw new ErrorHttp(409, "El CCF todav\xEDa no est\xE1 sellado por Hacienda");
  const c = await cliente(db, inv.receptor_customer_id ?? inv.customer_id, orgId);
  const { data: venta } = await db.rpc("fiscal_sale_for_emission", { p_invoice_id: invoiceId, p_organization_id: orgId });
  const lineas = venta?.lineas ?? [];
  const sale = {
    order_id: inv.id,
    organization_id: orgId,
    branch_id: inv.branch_id,
    order_number: inv.invoice_number,
    created_at: inv.created_at,
    status: "delivered",
    order_kind: "service",
    subtotal: Number(inv.subtotal),
    tax_total: Number(inv.tax_amount),
    total: Number(inv.total),
    items: lineas.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, unitario: Number(l.precioUni), total: Number(l.precioUni) * l.cantidad })),
    customer_name: c?.nombre ?? "",
    customer_type: c?.customer_type ?? "company",
    customer_trade_name: c?.trade_name ?? null,
    customer_nit: c?.nit ?? null,
    customer_nrc: c?.nrc ?? null,
    customer_dui: c?.dui ?? null,
    customer_cod_actividad: c?.cod_actividad ?? null,
    customer_desc_actividad: c?.desc_actividad ?? null,
    customer_phone: c?.phone ?? null,
    customer_email: c?.correo ?? null,
    customer_departamento: c?.departamento ?? null,
    customer_municipio: c?.municipio ?? null,
    customer_direccion: c?.direccion ?? null,
    plate: null,
    payment_method: "Cr\xE9dito",
    invoice_id: inv.id,
    invoice_type: inv.invoice_type,
    invoice_number: inv.invoice_number
  };
  const emisor = await emisorDeSucursal(db, inv.branch_id);
  const navegador = await abrirNavegador();
  try {
    const nombre = doc.dte.numeroControl ?? inv.invoice_number;
    const adjuntos = [
      { filename: `${nombre}.pdf`, content: await htmlAPdf(navegador, buildFacturaHTML(sale, emisor, doc.dte)), contentType: "application/pdf" },
      ...doc.json ? [{ filename: `${nombre}.json`, content: JSON.stringify(doc.json, null, 2), contentType: "application/json" }] : []
    ];
    const html = layout({
      appUrl,
      emisor,
      preheader: `CCF consolidado ${doc.dte.numeroControl} \xB7 ${lineas.length} lavados \xB7 ${money4(Number(inv.total))}`,
      titulo: "Tu comprobante de cr\xE9dito fiscal",
      cuerpo: parrafo(`${saludo(c)}: adjuntamos el CCF consolidado de tus lavados, con el detalle de cada placa, en PDF y su archivo JSON.`) + tarjeta("Documento", [
        fila2("N\xFAmero de control", `<span style="font-family:monospace">${esc4(doc.dte.numeroControl)}</span>`),
        fila2("C\xF3digo de generaci\xF3n", `<span style="font-family:monospace;font-size:11.5px">${esc4(doc.dte.codigoGeneracion)}</span>`),
        fila2("Lavados facturados", String(lineas.length)),
        fila2("Total", money4(Number(inv.total)), true)
      ].join("")) + (doc.dte.qrUrl ? parrafo(boton("Verificar en Hacienda", doc.dte.qrUrl)) : "") + parrafo("\xA1Gracias por seguir confiando en CORSA Carwash!")
    });
    return enviarYRegistrar({
      db,
      orgId,
      userId,
      tipo: "ccf_consolidado",
      correoCliente: c?.correo ?? null,
      asunto: `CCF consolidado CORSA Carwash \xB7 ${doc.dte.numeroControl}`,
      html,
      adjuntos,
      invoiceId,
      fiscalDocumentId: doc.id,
      customerId: c?.id ?? null
    });
  } finally {
    await navegador.close();
  }
}
async function correoEstadoCuenta(db, orgId, userId, appUrl, customerId) {
  const c = await cliente(db, customerId, orgId);
  if (!c) throw new ErrorHttp(404, "No existe ese cliente");
  const cxc = await datosCxc(db, customerId, orgId);
  if (!cxc.cuenta) throw new ErrorHttp(409, "El cliente no tiene cuenta de cr\xE9dito");
  const { data: ultimaSucursal } = await db.from("work_orders").select("branch_id").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const emisor = await emisorDeSucursal(db, ultimaSucursal?.branch_id ?? null);
  const navegador = await abrirNavegador();
  try {
    const pdf = await htmlAPdf(navegador, estadoCuentaHTML({ emisor, cliente: cxc.cuenta, documentos: cxc.documentos, movimientos: cxc.movimientos, lavados: cxc.lavados }));
    const cta = cxc.cuenta;
    const pendientes = cxc.lavados.filter((l) => !l.consolidated_invoice_id).length;
    const html = layout({
      appUrl,
      emisor,
      preheader: `Saldo a la fecha ${money4(cta.saldo)}`,
      titulo: "Tu estado de cuenta",
      cuerpo: parrafo(`${saludo(c)}: gracias por ser cliente de CORSA Carwash. Te compartimos tu estado de cuenta al ${esc4(fechaSV(/* @__PURE__ */ new Date()))}.`) + tarjeta("Resumen", [
        fila2("Saldo total", money4(cta.saldo), true),
        fila2("Por vencer", money4(cta.por_vencer)),
        fila2("Vencido", cta.vencido > 0 ? `<span style="color:#C2272D;font-weight:700">${money4(cta.vencido)}</span>` : money4(0)),
        fila2("Cr\xE9dito disponible", money4(cta.disponible)),
        ...pendientes ? [fila2("Lavados pendientes de facturar", String(pendientes))] : []
      ].join("")) + (cta.vencido > 0 ? aviso("Tienes saldo vencido. Si ya realizaste el pago, por favor comp\xE1rtenos el comprobante.", "ambar") : "") + parrafo("El detalle de documentos, lavados y abonos va en el PDF adjunto.")
    });
    return enviarYRegistrar({
      db,
      orgId,
      userId,
      tipo: "estado_cuenta",
      correoCliente: c.correo,
      asunto: `Estado de cuenta CORSA Carwash \xB7 ${fechaSV(/* @__PURE__ */ new Date())}`,
      html,
      adjuntos: [{ filename: `estado-de-cuenta-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.pdf`, content: pdf, contentType: "application/pdf" }],
      customerId
    });
  } finally {
    await navegador.close();
  }
}
async function correoCierreCaja(db, orgId, userId, appUrl, sessionId) {
  const { data, error } = await db.rpc("caja_resumen_datos", { p_session_id: sessionId });
  if (error || !data) throw new ErrorHttp(404, "No existe ese turno de caja");
  if (data.organization_id !== orgId) throw new ErrorHttp(404, "No existe ese turno de caja");
  const { data: s } = await db.from("cash_sessions").select("resumen").eq("id", sessionId).maybeSingle();
  const r = normalizarResumen(s?.resumen ?? data);
  const emisor = await emisorDeSucursal(db, r.branch_id);
  const dia = diaDelTurno(r.abierta_at);
  const navegador = await abrirNavegador();
  try {
    const pdf = await htmlAPdf(navegador, reporteCierreHTML({ emisor, resumen: r }));
    const retiros = r.movimientos.filter((m) => m.tipo === "cash_out");
    const html = layout({
      appUrl,
      emisor,
      preheader: `${r.sucursal} \xB7 ventas ${money4(r.ventas.total)} \xB7 queda en caja ${money4(r.efectivo_final)}`,
      titulo: "Cierre de caja",
      cuerpo: parrafo(`Cierre de caja de <strong>${esc4(r.sucursal)}</strong>, ${esc4(dia)}. Cerr\xF3 ${esc4(r.cerro ?? "\u2014")}.`) + tarjeta("Ventas", [
        fila2("Efectivo", money4(r.ventas.efectivo)),
        fila2("Tarjeta", money4(r.ventas.tarjeta)),
        fila2("Transferencia", money4(r.ventas.transferencia)),
        ...r.ventas.otros > 0 ? [fila2("Otros", money4(r.ventas.otros))] : [],
        fila2(`Total (${r.ventas.cantidad} ventas)`, money4(r.ventas.total), true)
      ].join("")) + tarjeta("Efectivo", [
        fila2("Efectivo inicial", money4(r.efectivo_inicial)),
        fila2("Ingresos en efectivo", money4(r.ingresos_efectivo)),
        fila2(`Retiros (${retiros.length})`, money4(r.egresos_efectivo)),
        fila2("Remesa", money4(r.remesa)),
        fila2("Efectivo final en caja", money4(r.efectivo_final), true)
      ].join("")) + (retiros.length ? tarjeta("Retiros de efectivo", retiros.map((m) => fila2(`${esc4(m.motivo)} \xB7 autoriz\xF3 ${esc4(m.autorizo ?? "\u2014")}`, money4(m.monto))).join("")) : "") + parrafo("El reporte completo va en el PDF adjunto.")
    });
    return enviarYRegistrar({
      db,
      orgId,
      userId,
      tipo: "cierre_caja",
      correoCliente: null,
      destinos: { to: DESTINOS_CIERRE_CAJA, bcc: COPIA_TEMPORAL.filter((c) => !DESTINOS_CIERRE_CAJA.includes(c)) },
      asunto: `Cierre de caja \xB7 ${r.sucursal} \xB7 ${dia}`,
      html,
      adjuntos: [{ filename: `cierre-de-caja-${r.abierta_at.slice(0, 10)}.pdf`, content: pdf, contentType: "application/pdf" }],
      cashSessionId: sessionId
    });
  } finally {
    await navegador.close();
  }
}
async function manejar(args) {
  try {
    const jwt = (args.auth ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) throw new ErrorHttp(401, "Falta la sesi\xF3n");
    const db = admin();
    const { userId, orgId } = await usuarioDe(db, jwt).catch((e) => {
      throw new ErrorHttp(e.status ?? 401, e.message);
    });
    const b = args.cuerpo ?? {};
    const uuid = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
    if (b.accion === "venta" && uuid(b.workOrderId)) return await correoDeVenta(db, orgId, userId, args.appUrl, b.workOrderId);
    if (b.accion === "factura" && uuid(b.invoiceId)) return await correoDeFactura(db, orgId, userId, args.appUrl, b.invoiceId);
    if (b.accion === "estado_cuenta" && uuid(b.customerId)) return await correoEstadoCuenta(db, orgId, userId, args.appUrl, b.customerId);
    if (b.accion === "cierre_caja" && uuid(b.sessionId)) return await correoCierreCaja(db, orgId, userId, args.appUrl, b.sessionId);
    throw new ErrorHttp(400, "Solicitud inv\xE1lida");
  } catch (e) {
    if (e instanceof ErrorHttp) return { status: e.status, body: { ok: false, error: e.message } };
    console.error("[correo]", e);
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : "Error interno" } };
  }
}

// server/correo/entrada.ts
var config = { maxDuration: 60 };
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
