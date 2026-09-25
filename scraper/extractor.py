import sys
import json
import re
import requests
from bs4 import BeautifulSoup

# Cabeceras para simular un navegador real
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "es-ES,es;q=0.9"
}

def resolver_streamwish(url):
    """ Extrae flujos .m3u8 de Streamwish """
    try:
        res = requests.get(url, headers=HEADERS, timeout=10)
        # Buscar patrón de URL .m3u8 en el código fuente / scripts desofuscados
        match = re.search(r'file:\s*["\'](https?://[^\'"]+\.m3u8[^\'"]*)["\']', res.text)
        if match:
            return {"streamUrl": match.group(1), "type": "hls", "headers": {"Referer": url}}
    except Exception as e:
        pass
    return None

def resolver_uqload(url):
    """ Extrae enlace de video MP4 directo de Uqload """
    try:
        res = requests.get(url, headers=HEADERS, timeout=10)
        match = re.search(r'sources:\s*\[["\'](https?://[^\'"]+\.mp4[^\'"]*)["\']\]', res.text)
        if match:
            return {"streamUrl": match.group(1), "type": "mp4", "headers": {"Referer": url}}
    except Exception as e:
        pass
    return None

def resolver_doodstream(url):
    """ Extrae enlace directo de Doodstream """
    try:
        # Transformar URL embebida
        embed_url = url.replace('/d/', '/e/')
        res = requests.get(embed_url, headers=HEADERS, timeout=10)
        match = re.search(r"/pass_md5/[^'\"]*", res.text)
        if match:
            pass_url = "https://dood.so" + match.group(0)
            headers_dood = HEADERS.copy()
            headers_dood["Referer"] = embed_url
            res_pass = requests.get(pass_url, headers=headers_dood, timeout=10)
            token = res_pass.text
            # Construir URL final de descarga
            stream_url = token + "~123456789?token=" + pass_url.split('/')[-1]
            return {"streamUrl": stream_url, "type": "mp4", "headers": {"Referer": embed_url}}
    except Exception as e:
        pass
    return None

def resolver_filemoon(url):
    """ Extrae flujos .m3u8 de Filemoon """
    try:
        res = requests.get(url, headers=HEADERS, timeout=10)
        match = re.search(r'file:\s*["\'](https?://[^\'"]+\.m3u8[^\'"]*)["\']', res.text)
        if match:
            return {"streamUrl": match.group(1), "type": "hls", "headers": {"Referer": url}}
    except Exception as e:
        pass
    return None

def extraer_stream(url):
    """ Enruta la URL ingresada al extractor correspondiente """
    url_lower = url.lower()
    
    if "streamwish" in url_lower or "swish" in url_lower:
        return resolver_streamwish(url)
    elif "uqload" in url_lower:
        return resolver_uqload(url)
    elif "dood" in url_lower:
        return resolver_doodstream(url)
    elif "filemoon" in url_lower:
        return resolver_filemoon(url)
    else:
        # Fallback genérico para tratar de encontrar enlaces m3u8 o mp4
        try:
            res = requests.get(url, headers=HEADERS, timeout=10)
            match_m3u8 = re.search(r'(https?://[^\'"]+\.m3u8[^\'"]*)', res.text)
            if match_m3u8:
                return {"streamUrl": match_m3u8.group(1), "type": "hls", "headers": {"Referer": url}}
            
            match_mp4 = re.search(r'(https?://[^\'"]+\.mp4[^\'"]*)', res.text)
            if match_mp4:
                return {"streamUrl": match_mp4.group(1), "type": "mp4", "headers": {"Referer": url}}
        except Exception:
            pass

    return None

if __name__ == "__main__":
    if len(sys.argv) > 1:
        target_url = sys.argv[1]
        resultado = extraer_stream(target_url)
        
        if resultado:
            print(json.dumps({"success": True, "data": resultado}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "message": "No se pudo extraer el flujo de video"}, ensure_ascii=False))
    else:
        print(json.dumps({"success": False, "message": "Proporcione una URL para extraer"}, ensure_ascii=False))