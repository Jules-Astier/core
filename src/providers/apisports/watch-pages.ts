export type ApiSportsWatchPageCategory =
    | 'soccer'
    | 'nfl'
    | 'nba'
    | 'wnba'
    | 'nhl'
    | 'mma'
    | 'boxing'
    | 'ncaa'
    | 'wwe'
    | 'f1'
    | 'mlb'
    | 'cfl'
    | 'motogp';

export const API_SPORTS_WATCH_PAGES: Record<
    ApiSportsWatchPageCategory,
    string[]
> = {
    soccer: [
        'https://methstreams.ms/league/soccerstreams',
        'https://methstreams.dad/league/soccerstreams',
        'https://buffstreams.plus/soccer-live-streams',
        'https://streameastv1.com/schedule/soccer',
        'https://streamseast.cc/soccer'
    ],
    nfl: [
        'https://methstreams.ms/league/nflstreams',
        'https://methstreams.dad/league/nflstreams',
        'https://buffstreams.plus/nflstreams2',
        'https://streameastv1.com/schedule/nfl',
        'https://streamseast.cc/nfl'
    ],
    nba: [
        'https://methstreams.ms/league/nbastreams',
        'https://crackstreams.ms/league/nbastreams',
        'https://methstreams.dad/league/nbastreams',
        'https://buffstreams.plus/nbastreams2',
        'https://streameastv1.com/schedule/nba',
        'https://streamseast.cc/nba'
    ],
    wnba: [
        'https://methstreams.ms/league/wnbastreams',
        'https://crackstreams.ms/league/wnbastreams',
        'https://methstreams.dad/league/wnbastreams',
        'https://buffstreams.plus/wnbastreams',
        'https://streameastv1.com/schedule/wnba'
    ],
    nhl: [
        'https://methstreams.ms/league/nhlstreams',
        'https://crackstreams.ms/league/nhlstreams',
        'https://methstreams.dad/league/nhlstreams',
        'https://buffstreams.plus/nhlstreams2',
        'https://streameastv1.com/schedule/nhl',
        'https://streamseast.cc/nhl'
    ],
    mma: [
        'https://methstreams.ms/league/mmastreams',
        'https://crackstreams.ms/league/mmastreams',
        'https://methstreams.dad/league/mmastreams',
        'https://buffstreams.plus/mmastreams2',
        'https://streameastv1.com/schedule/ufc',
        'https://streamseast.cc/mma'
    ],
    boxing: [
        'https://methstreams.ms/league/boxingcasino',
        'https://crackstreams.ms/league/boxingcasino',
        'https://methstreams.dad/league/boxingcasino',
        'https://buffstreams.plus/boxingstreams2',
        'https://streameastv1.com/schedule/boxing',
        'https://streamseast.cc/boxing'
    ],
    ncaa: [
        'https://methstreams.ms/league/ncaa',
        'https://crackstreams.ms/league/ncaa',
        'https://methstreams.dad/league/ncaa',
        'https://buffstreams.plus/cfbstreams2',
        'https://buffstreams.plus/ncaastreams',
        'https://streameastv1.com/schedule/cfb',
        'https://streameastv1.com/schedule/ncaab'
    ],
    wwe: [
        'https://methstreams.ms/league/wwestreams',
        'https://methstreams.ms/category/wwe-aew',
        'https://crackstreams.ms/league/wwestreams',
        'https://crackstreams.ms/category/wwe-aew',
        'https://methstreams.dad/league/wwestreams',
        'https://methstreams.dad/category/wwe-aew',
        'https://buffstreams.plus/wwestreams',
        'https://streameastv1.com/schedule/wwe'
    ],
    f1: [
        'https://methstreams.ms/league/f1streams',
        'https://crackstreams.ms/league/f1streams',
        'https://methstreams.dad/league/f1streams',
        'https://buffstreams.plus/f1streams2',
        'https://streameastv1.com/schedule/f1',
        'https://streamseast.cc/f1'
    ],
    mlb: [
        'https://buffstreams.plus/mlb-live-streams',
        'https://streameastv1.com/schedule/mlb',
        'https://streamseast.cc/mlb'
    ],
    cfl: ['https://streameastv1.com/schedule/cfl'],
    motogp: ['https://streameastv1.com/schedule/motogp']
};
