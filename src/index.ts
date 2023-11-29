/* -*- indent-tabs-mode: nil; tab-width: 2; -*- */
/* vim: set ts=2 sw=2 et ai : */
/**
  Node.JS LibreNMS Weathermap
  Copyright (C) 2023 Menhera.org

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  @license
**/

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as url from 'node:url';

import fetch from 'node-fetch';
import xmlescape from 'xml-escape';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export interface Config {
  title: string;
  width: number;
  height: number;
  devices: ConcreteDeviceDefinition[];
  sites: SiteDefinition[];
  colors?: ColorDefinition;
}

// In bps.
// 10M = 0.5px, 100M = 1px, 1G = 2px, 10G = 4px, 40G = 6px, 100G = 8px
export type ConnectionSpeed = '10M' | '100M' | '1G' | '10G' | '40G' | '100G';

export type ColorDefinition = Record<number, string>; // bps -> CSS color

export const DEFAULT_COLORS: Readonly<ColorDefinition> = {
  [-1]: '#cccccc', // inactive
  0: '#000000',
  1000000: '#0000ff',
  10000000: '#00cccc',
  25000000: '#00ff00',
  50000000: '#cccc00',
  75000000: '#ee7000',
  100000000: '#ff0000',
};

export interface DeviceDefinition {
  type: string;
  name: string; // must be unique
  render_x: number;
  render_y: number;
  label_position: 'top' | 'bottom';
  librenms_hostname?: string;
  connections?: ConnectionDefinition[];
}

export interface SwitchDefinition extends DeviceDefinition {
  type: 'switch';
}

export interface RouterDefinition extends DeviceDefinition {
  type: 'router';
}

export interface CloudDefinition extends DeviceDefinition {
  type: 'cloud';
}

export type ConcreteDeviceDefinition = SwitchDefinition | RouterDefinition | CloudDefinition;

export interface ConnectionDefinition {
  peer: string; // name of the peer router
  interface_name: string; // name of the interface on this router
  speed: ConnectionSpeed;
}

export interface SiteDefinition {
  name: string;
  render_x: number;
  render_y: number;
  width: number;
  height: number;
  label_position: 'top' | 'bottom';
}

export interface ConnectionData {
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  speed: ConnectionSpeed;
  outboundTraffic: number; // in bps, -1 if inactive
  inboundTraffic: number; // in bps, -1 if inactive
}

export type SiteData = SiteDefinition;

export interface DeviceData {
  type: 'switch' | 'router' | 'cloud';
  name: string;
  render_x: number;
  render_y: number;
  label_position: 'top' | 'bottom';
}

export interface RenderData {
  title: string;
  width: number;
  height: number;
  devices: DeviceData[];
  sites: SiteData[];
  connections: ConnectionData[];
  colors: ColorDefinition;
}

interface LibrenmsPort {
  port_id: number;
  ifName: string;
}

const CONFIG_PATH = path.join(__dirname, '../config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '../config.default.json');

export const loadConfig = async (configPath: string | null = null): Promise<Config> => {
  try {
    const config = await fs.readFile(configPath || CONFIG_PATH, { encoding: 'utf-8' });
    return JSON.parse(config);
  } catch (e) {
    const defaultConfig = await fs.readFile(DEFAULT_CONFIG_PATH, { encoding: 'utf-8' });
    return JSON.parse(defaultConfig);
  }
};

const getV1Api = async (url: string): Promise<any> => {
  const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN;
  if (!LIBRENMS_TOKEN) {
    throw new Error('LIBRENMS_TOKEN is not set');
  }
  const LIBRENMS_SERVER = process.env.LIBRENMS_SERVER;
  if (!LIBRENMS_SERVER) {
    throw new Error('LIBRENMS_SERVER is not set');
  }
  const urlObj = new URL(url, LIBRENMS_SERVER);
  const response = await fetch(urlObj.href, {
    headers: {
      'X-Auth-Token': LIBRENMS_TOKEN
    },
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  // console.debug(`Fetched ${url}`, data);
  return data;
};

export const fetchRenderData = async (config: Config): Promise<RenderData> => {
  const devices = config.devices || [];
  const deviceDataList: DeviceData[] = [];
  const connectionDataList: ConnectionData[] = [];
  for (const device of devices) {
    const deviceData: DeviceData = {
      type: device.type,
      name: device.name,
      render_x: device.render_x,
      render_y: device.render_y,
      label_position: device.label_position,
    };
    deviceDataList.push(deviceData);
    if (!device.librenms_hostname || !device.connections) {
      continue;
    }
    const hostname = device.librenms_hostname;
    const connections = device.connections;
    const deviceId = (await getV1Api(`/api/v0/devices/${encodeURIComponent(hostname)}`))?.devices[0]?.device_id as number;
    if (null == deviceId) {
      throw new Error(`Device not found: ${hostname}`);
    }
    const ports = (await getV1Api(`/api/v0/ports/search/device_id/${deviceId}`)).ports as LibrenmsPort[];
    for (const connection of connections) {
      const peer = devices.find((d) => d.name === connection.peer);
      if (!peer) {
        continue;
      }
      const from_x = device.render_x;
      const from_y = device.render_y;
      const to_x = peer.render_x;
      const to_y = peer.render_y;
      const speed = connection.speed;
      const interfaceName = connection.interface_name;
      const portId = ports.find((p) => p.ifName === interfaceName)?.port_id;
      let outboundTraffic = -1; // interface inactive
      let inboundTraffic = -1; // interface inactive
      if (portId) {
        const port = (await getV1Api(`/api/v0/ports/${portId}`))?.port[0] as any;
        if (port?.ifOperStatus !== 'up') {
          continue;
        }
        outboundTraffic = port.ifOutOctets_rate != null ? port.ifOutOctets_rate * 8 : -1;
        inboundTraffic = port.ifInOctets_rate != null ? port.ifInOctets_rate * 8 : -1;
      }
      const connectionData: ConnectionData = {
        from_x,
        from_y,
        to_x,
        to_y,
        speed,
        outboundTraffic,
        inboundTraffic,
      };
      connectionDataList.push(connectionData);
    }
  }
  const sites = config.sites || [];
  const siteDataList: SiteData[] = [];
  for (const site of sites) {
    const siteData: SiteData = {
      name: site.name,
      render_x: site.render_x,
      render_y: site.render_y,
      width: site.width,
      height: site.height,
      label_position: site.label_position,
    };
    siteDataList.push(siteData);
  }
  const renderData: RenderData = {
    title: config.title,
    width: config.width,
    height: config.height,
    devices: deviceDataList,
    sites: siteDataList,
    connections: connectionDataList,
    colors: config.colors || DEFAULT_COLORS,
  };
  return renderData;
};

const renderToSvg = (title: string, width: number, height: number, elements: string[], defsElements: string[] = []): string => {
  const content = elements.join('\n');
  const defsContent = defsElements.join('\n  ');
  return `<!-- Rendered with node-librenms-weathermap -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" font-family="sans-serif">
<defs>
  <g id="router" transform="translate(-25, -25)">
    <ellipse cx="25" cy="25" rx="25" ry="25" fill="#fafafa" stroke="none"/>
    <path d="M 38.08 40.38 L 31.77 34.19 L 29.2 36.81 L 27.24 27.37 L 36.75 29.12 L 34.2 31.72 L 40.51 37.9 Z M 23.92 28.37 L 17.74 34.68 L 20.36 37.25 L 10.92 39.21 L 12.67 29.71 L 15.26 32.25 L 21.45 25.95 Z M 12.02 9.57 L 18.33 15.76 L 20.89 13.14 L 22.86 22.58 L 13.35 20.83 L 15.9 18.24 L 9.59 12.05 Z M 25.91 21.51 L 32.1 15.2 L 29.48 12.63 L 38.92 10.67 L 37.17 20.17 L 34.58 17.62 L 28.39 23.94 Z M 25 0 C 11.2 0 0 11.2 0 25 C 0 38.8 11.2 50 25 50 C 38.8 50 50 38.8 50 25 C 50 11.2 38.8 0 25 0 Z M 25 0.63 C 38.46 0.63 49.37 11.54 49.37 25 C 49.37 38.46 38.46 49.37 25 49.37 C 11.54 49.37 0.63 38.46 0.63 25 C 0.63 11.54 11.54 0.63 25 0.63 Z" fill="#005073" stroke="none"/>
  </g>
  <g id="switch" transform="translate(-25, -25)">
    <path d="M 3.07 0 C 1.38 0 0 1.37 0 3.05 L 0 46.95 C 0 48.63 1.38 50 3.07 50 L 46.93 50 C 48.62 50 50 48.63 50 46.95 L 50 3.05 C 50 1.37 48.62 0 46.93 0 Z" fill="#fafafa" stroke="none"/>
    <path d="M 23.38 40.52 L 23.38 36.53 L 12.78 36.53 L 12.78 33.39 L 3.75 38.71 L 12.78 43.96 L 12.78 40.52 Z M 28.32 21.46 L 28.32 17.48 L 17.73 17.48 L 17.73 14.33 L 8.7 19.66 L 17.73 24.9 L 17.73 21.46 Z M 22.38 31.06 L 22.38 27.08 L 32.98 27.08 L 32.98 23.93 L 42 29.26 L 32.98 34.51 L 32.98 31.06 Z M 26.96 12.32 L 26.96 8.34 L 37.55 8.34 L 37.55 5.2 L 46.58 10.52 L 37.55 15.77 L 37.55 12.32 Z M 3.07 0 C 1.38 0 0 1.37 0 3.05 L 0 46.95 C 0 48.63 1.38 50 3.07 50 L 46.93 50 C 48.62 50 50 48.63 50 46.95 L 50 3.05 C 50 1.37 48.62 0 46.93 0 Z M 3.07 1.38 L 46.93 1.38 C 47.88 1.38 48.62 2.11 48.62 3.05 L 48.62 46.95 C 48.62 47.89 47.88 48.62 46.93 48.62 L 3.07 48.62 C 2.12 48.62 1.38 47.89 1.38 46.95 L 1.38 3.05 C 1.38 2.11 2.12 1.38 3.07 1.38 Z" fill="#005073" stroke="none"/>
  </g>
  <g id="cloud" transform="translate(-64, -40)">
    <path d="M 30 20 C 6 20 0 40 19.2 44 C 0 52.8 21.6 72 37.2 64 C 48 80 84 80 96 64 C 120 64 120 48 105 40 C 120 24 96 8 75 16 C 60 4 36 4 30 20 Z" fill="#ffffff" stroke="#000000" stroke-miterlimit="10"/>
  </g>
  <path id="arrow-marker" d="M 0 0 L 10 5 L 0 10 z"/>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" markerUnits="strokeWidth" orient="auto-start-reverse" fill="context-stroke"><use xlink:href="#arrow-marker"/></marker>
  ${defsContent}
</defs>
<title>${xmlescape(title)}</title>
${content}
</svg>`;
};

const getArrowMarkerId = (color: string): string => {
  return `arrow-${String(color).replace('#', '')}`;
};

const createArrowMarker = (color: string): string => {
  return `<marker id="${getArrowMarkerId(color)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" markerUnits="strokeWidth" orient="auto-start-reverse" fill="${color}"><use xlink:href="#arrow-marker"/></marker>`;
};

const renderBackground = (width: number, height: number): string => {
  return `<rect x="0" y="0" width="${width}" height="${height}" fill="#f2f2f2" stroke="none"/>`;
};

const renderDiagramTitle = (title: string, fontSize = 24): string => {
  return `<text x="50%" y="${fontSize * 2}" text-anchor="middle" font-size="${fontSize}">${xmlescape(title)}</text>`;
};

const formatTraffic = (traffic: number): string => {
  if (traffic < 0) {
    return 'Inactive';
  }
  if (traffic < 100000) {
    return `${(traffic / 1000).toFixed(2)} kbps`;
  }
  if (traffic < 100000000) {
    return `${(traffic / 1000000).toFixed(2)} Mbps`;
  }
  return `${(traffic / 1000000000).toFixed(2)} Gbps`;
};

const renderTraffic = (x: number, y: number, traffic: number, fontSize = 12): string => {
  const width = fontSize * 6;
  const rect = `<rect x="${x - width / 2}" y="${y - fontSize * 0.75}" width="${width}" height="${fontSize * 1.5}" fill="#ffffff" stroke="#000000" stroke-miterlimit="10"/>`;
  const text = `<text x="${x}" y="${y + fontSize / 2}" text-anchor="middle" font-size="${fontSize}" fill="#000000" stroke="none">${xmlescape(formatTraffic(traffic))}</text>`;
  return `${rect}\n${text}`;
};

const getStrokeWidth = (speed: ConnectionSpeed): number => {
  return speed === '10M' ? 0.5 : speed === '100M' ? 1 : speed === '1G' ? 2 : speed === '10G' ? 4 : speed === '40G' ? 6 : speed === '100G' ? 8 : 0;
};

const getStrokeColor = (traffic: number, colors: ColorDefinition): string => {
  const sortedSpeeds = Object.keys(colors).map((s) => parseInt(s)).sort((a, b) => b - a);
  const speed = sortedSpeeds.find((s) => s <= traffic);
  return colors[speed || sortedSpeeds[sortedSpeeds.length - 1]!] || '#000000';
};

const renderConnection = (connection: ConnectionData, colors: ColorDefinition): { arrowElements: string[], labelElements: string[], defsElements: string[] } => {
  const middleX = connection.from_x + (connection.to_x - connection.from_x) / 2;
  const middleY = connection.from_y + (connection.to_y - connection.from_y) / 2;
  const spanX = Math.abs(connection.to_x - connection.from_x);
  const spanY = Math.abs(connection.to_y - connection.from_y);
  const length = Math.sqrt((connection.to_x - connection.from_x) ** 2 + (connection.to_y - connection.from_y) ** 2);
  const normalizedVectorX = (connection.to_x - connection.from_x) / length;
  const normalizedVectorY = (connection.to_y - connection.from_y) / length;
  const trafficTextWidth = 72;
  const strokeWidth = getStrokeWidth(connection.speed);
  let outboundTrafficLabelX = middleX - normalizedVectorX * (trafficTextWidth / 2 + 8 + strokeWidth * 6);
  let outboundTrafficLabelY = middleY - normalizedVectorY * (trafficTextWidth / 2 + 8 + strokeWidth * 6);
  let inboundTrafficLabelX = middleX + normalizedVectorX * (trafficTextWidth / 2 + 8 + strokeWidth * 6);
  let inboundTrafficLabelY = middleY + normalizedVectorY * (trafficTextWidth / 2 + 8 + strokeWidth * 6);
  if (spanY > 48 && spanX < 192) {
    const factor = (12 + strokeWidth * 6) / Math.abs(normalizedVectorY);
    outboundTrafficLabelX = middleX - normalizedVectorX * factor;
    outboundTrafficLabelY = middleY - normalizedVectorY * factor;
    inboundTrafficLabelX = middleX + normalizedVectorX * factor;
    inboundTrafficLabelY = middleY + normalizedVectorY * factor;
  }
  const defsElements: string[] = [];
  const outboundColor = getStrokeColor(connection.outboundTraffic, colors);
  const inboundColor = getStrokeColor(connection.inboundTraffic, colors);
  const outboundArrowMarker = createArrowMarker(outboundColor);
  const inboundArrowMarker = createArrowMarker(inboundColor);
  const outboundArrowMarkerId = getArrowMarkerId(outboundColor);
  const inboundArrowMarkerId = getArrowMarkerId(inboundColor);
  defsElements.push(outboundArrowMarker);
  defsElements.push(inboundArrowMarker);
  const outboundArrow = `<path d="M ${connection.from_x} ${connection.from_y} L ${middleX} ${middleY}" stroke="${outboundColor}" stroke-width="${strokeWidth}" marker-end="url(#${outboundArrowMarkerId})"/>`;
  const inboundArrow = `<path d="M ${connection.to_x} ${connection.to_y} L ${middleX} ${middleY}" stroke="${inboundColor}" stroke-width="${strokeWidth}" marker-end="url(#${inboundArrowMarkerId})"/>`;
  const outboundTraffic = renderTraffic(outboundTrafficLabelX, outboundTrafficLabelY, connection.outboundTraffic);
  const inboundTraffic = renderTraffic(inboundTrafficLabelX, inboundTrafficLabelY, connection.inboundTraffic);
  return {
    arrowElements: [outboundArrow, inboundArrow],
    labelElements: [outboundTraffic, inboundTraffic],
    defsElements,
  };
};

const renderDevice = (device: DeviceData): string => {
  let deviceSvg = '';
  let deviceHeight = 50;
  switch (device.type) {
    case 'switch':
      deviceSvg = `<use xlink:href="#switch" x="${device.render_x}" y="${device.render_y}"/>`;
      break;
    case 'router':
      deviceSvg = `<use xlink:href="#router" x="${device.render_x}" y="${device.render_y}"/>`;
      break;
    case 'cloud':
      deviceSvg = `<use xlink:href="#cloud" x="${device.render_x}" y="${device.render_y}"/>`;
      deviceHeight = 80;
      break;
  }
  const labelY = device.label_position === 'top' ? device.render_y - (deviceHeight / 2 + 4) : device.render_y + (deviceHeight / 2 + 20);
  const labelSvg = `<text x="${device.render_x}" y="${labelY}" text-anchor="middle" font-size="16" fill="#000000" stroke="none">${xmlescape(device.name)}</text>`;
  return `${deviceSvg}\n${labelSvg}`;
};

const renderSite = (site: SiteData): string => {
  const siteSvg = `<rect x="${site.render_x}" y="${site.render_y}" width="${site.width}" height="${site.height}" rx="16" fill="#ffffff" stroke="#000000" stroke-miterlimit="10"/>`;
  const labelY = site.label_position === 'top' ? site.render_y + 24 : site.render_y + site.height - 8;
  const labelSvg = `<text x="${site.render_x + site.width / 2}" y="${labelY}" text-anchor="middle" font-size="16" fill="#000000" stroke="none">${xmlescape(site.name)}</text>`;
  return `${siteSvg}\n${labelSvg}`;
};

const renderDate = (renderData: RenderData): string => {
  const x = renderData.width - 8;
  const y = renderData.height - 8;
  const date = (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  return `<text x="${x}" y="${y}" text-anchor="end" font-size="12" fill="#000000" stroke="none">${xmlescape(date)}</text>`;
};

export const render = (renderData: RenderData): string => {
  const elements: string[] = [];
  const defsElements: string[] = [];
  elements.push(renderBackground(renderData.width, renderData.height));
  elements.push(renderDiagramTitle(renderData.title));
  for (const site of renderData.sites) {
    elements.push(renderSite(site));
  }
  const arrowElements: string[] = [];
  const labelElements: string[] = [];
  for (const connection of renderData.connections) {
    const connectionElements = renderConnection(connection, renderData.colors);
    arrowElements.push(...connectionElements.arrowElements);
    labelElements.push(...connectionElements.labelElements);
    defsElements.push(...connectionElements.defsElements);
  }
  elements.push(...arrowElements);
  elements.push(...labelElements);
  for (const device of renderData.devices) {
    elements.push(renderDevice(device));
  }
  elements.push(renderDate(renderData));
  return renderToSvg(renderData.title, renderData.width, renderData.height, elements, [... new Set(defsElements)]);
};
