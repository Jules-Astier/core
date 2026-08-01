import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';

export class ShowboxFebboxProvider extends BaseProvider {
    readonly id = 'showboxfebbox';
    readonly name = 'Showbox/FebBox';
    readonly enabled = process.env.SHOWBOX_FEBBOX_ENABLED === 'true';
    readonly BASE_URL = 'https://www.febbox.com';
    readonly SHOWBOX_URL = 'https://www.showbox.media';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.SHOWBOX_URL}/`,
        Origin: this.SHOWBOX_URL
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult(
            'Provider scaffolded, but FebBox playback requires a cookie-backed resolver. Set SHOWBOX_FEBBOX_ENABLED only after adding that resolver.'
        );
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult(
            'Provider scaffolded, but FebBox playback requires a cookie-backed resolver. Set SHOWBOX_FEBBOX_ENABLED only after adding that resolver.'
        );
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
