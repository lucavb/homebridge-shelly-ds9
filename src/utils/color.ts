export interface Hsv {
    h: number;
    s: number;
    v: number;
}

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;

    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === rn) {
            h = 60 * (((gn - bn) / delta) % 6);
        } else if (max === gn) {
            h = 60 * ((bn - rn) / delta + 2);
        } else {
            h = 60 * ((rn - gn) / delta + 4);
        }
    }
    if (h < 0) {
        h += 360;
    }

    const s = max === 0 ? 0 : (delta / max) * 100;
    const v = max * 100;

    return { h, s, v };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
    const sn = s / 100;
    const vn = v / 100;

    const c = vn * sn;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = vn - c;

    let rp = 0;
    let gp = 0;
    let bp = 0;

    if (h < 60) {
        rp = c;
        gp = x;
    } else if (h < 120) {
        rp = x;
        gp = c;
    } else if (h < 180) {
        gp = c;
        bp = x;
    } else if (h < 240) {
        gp = x;
        bp = c;
    } else if (h < 300) {
        rp = x;
        bp = c;
    } else {
        rp = c;
        bp = x;
    }

    return {
        r: Math.round((rp + m) * 255),
        g: Math.round((gp + m) * 255),
        b: Math.round((bp + m) * 255),
    };
}
