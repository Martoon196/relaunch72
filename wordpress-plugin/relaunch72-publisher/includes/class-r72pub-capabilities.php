<?php
/**
 * Discovers what this WordPress site can truthfully support and describes it to
 * Relaunch72 as content-API v2 capabilities with the explicit URL extension
 * "wordpress-permalinks-1". Nothing here changes permalinks or any site setting.
 *
 * Supported post permalink structures: "/%postname%/" or a static prefix followed by
 * "%postname%" (for example "/blog/%postname%/" or "/insights/%postname%"), with or
 * without the trailing slash. Date, ID, category and author based structures put
 * values into the URL that are only known after publication, so they are reported as
 * an unsupported configuration instead of being approximated.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Capabilities {
	const SEGMENT = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

	/** Exact public origin (scheme://host) for the WordPress home URL. */
	public static function origin() {
		$home = wp_parse_url( home_url( '/' ) );
		return ( $home['scheme'] ?? '' ) . '://' . strtolower( $home['host'] ?? '' );
	}

	public static function home_issues() {
		$issues = array();
		$home   = wp_parse_url( home_url( '/' ) );
		if ( ( $home['scheme'] ?? '' ) !== 'https' ) {
			$issues[] = array( 'code' => 'home_not_https', 'message' => 'The WordPress Site Address (URL) must use https:// for Relaunch72 publishing. Change it in Settings → General only if your hosting already serves HTTPS.' );
		}
		if ( isset( $home['port'] ) ) {
			$issues[] = array( 'code' => 'home_port', 'message' => 'The Site Address includes a port number. Relaunch72 publishes only to a standard https origin.' );
		}
		return $issues;
	}

	/** @return array{supported:bool,structure:string,prefix:string,trailing:bool,message:string} */
	public static function permalink() {
		$structure = (string) get_option( 'permalink_structure', '' );
		$result    = array(
			'supported' => false,
			'structure' => $structure,
			'prefix'    => '',
			'trailing'  => false,
			'message'   => '',
		);
		if ( '' === $structure ) {
			$result['message'] = 'Plain permalinks (?p=123) are not supported. Relaunch72 will not change your permalink settings; an administrator can choose "Post name" in Settings → Permalinks after reviewing the effect on existing URLs.';
			return $result;
		}
		if ( ! preg_match( '#^((?:/[A-Za-z0-9._-]+)*)/%postname%(/?)$#', $structure, $m ) ) {
			$result['message'] = 'The permalink structure "' . $structure . '" includes values (such as dates, IDs, categories or author) that are only known after publication. Supported structures are /%postname%/ or a fixed prefix such as /blog/%postname%/. Relaunch72 has not changed anything.';
			return $result;
		}
		$result['supported'] = true;
		$result['prefix']    = $m[1];
		$result['trailing']  = '/' === $m[2];
		return $result;
	}

	public static function article_pattern() {
		$p = self::permalink();
		return home_url( $p['prefix'] . '/{slug}' . ( $p['trailing'] ? '/' : '' ) );
	}

	public static function article_url( $slug ) {
		return str_replace( '{slug}', $slug, self::article_pattern() );
	}

	public static function category_pattern() {
		global $wp_rewrite;
		$struct = $wp_rewrite ? $wp_rewrite->get_extra_permastruct( 'category' ) : '';
		if ( ! is_string( $struct ) || false === strpos( $struct, '%category%' ) ) {
			return '';
		}
		$path = user_trailingslashit( str_replace( '%category%', '{slug}', $struct ), 'category' );
		return home_url( $path );
	}

	/** The posts index: the assigned "Posts page", otherwise the home page. */
	public static function index() {
		$page_id = (int) get_option( 'page_for_posts' );
		if ( 'page' === get_option( 'show_on_front' ) && $page_id > 0 && 'publish' === get_post_status( $page_id ) ) {
			$page = get_post( $page_id );
			return array(
				'url'  => get_permalink( $page_id ),
				'path' => ( $page && 0 === (int) $page->post_parent ) ? $page->post_name : '',
			);
		}
		return array(
			'url'  => home_url( '/' ),
			'path' => '',
		);
	}

	public static function root_path() {
		$index = self::index();
		if ( '' !== $index['path'] && preg_match( self::SEGMENT, $index['path'] ) && strlen( $index['path'] ) <= 80 ) {
			return $index['path'];
		}
		$prefix   = trim( self::permalink()['prefix'], '/' );
		$segments = '' === $prefix ? array() : explode( '/', $prefix );
		if ( 1 === count( $segments ) && preg_match( self::SEGMENT, $segments[0] ) ) {
			return $segments[0];
		}
		return 'posts';
	}

	/** Everything that blocks a truthful connection, plus non-blocking warnings. */
	public static function evaluate() {
		$blocking = self::home_issues();
		$warnings = array();
		$p        = self::permalink();
		if ( ! $p['supported'] ) {
			$blocking[] = array( 'code' => 'permalink_unsupported', 'message' => $p['message'] );
		}
		if ( $p['supported'] && '' === self::category_pattern() ) {
			$blocking[] = array( 'code' => 'category_permalink', 'message' => 'Category archive URLs could not be determined from this site\'s rewrite rules.' );
		}
		$seo = R72Pub_Seo::status();
		if ( 'hold' === $seo['mode'] ) {
			$blocking[] = array( 'code' => 'seo_hold', 'message' => $seo['message'] );
		}
		$sitemap = R72Pub_Seo::sitemap();
		if ( '' === $sitemap['url'] ) {
			$blocking[] = array( 'code' => 'no_sitemap', 'message' => $sitemap['message'] );
		}
		$settings = R72Pub_Settings::get();
		$author   = $settings['author_id'] ? get_user_by( 'id', $settings['author_id'] ) : false;
		if ( ! $author || ! user_can( $author, 'publish_posts' ) || ! user_can( $author, 'upload_files' ) ) {
			$blocking[] = array( 'code' => 'author_required', 'message' => 'Choose the WordPress user Relaunch72 posts are published as (needs the publish_posts and upload_files capabilities) in Relaunch72 → Connection.' );
		}
		if ( in_array( $seo['mode'], array( 'yoast', 'rank_math' ), true ) && 'core' !== $sitemap['owner'] && function_exists( 'wp_sitemaps_get_server' ) && wp_sitemaps_get_server() && wp_sitemaps_get_server()->sitemaps_enabled() ) {
			$warnings[] = array( 'code' => 'sitemap_ambiguous', 'message' => $seo['provider'] . ' lists its sitemap as on, but WordPress core sitemaps are also still enabled. The SEO plugin may not be fully set up (for Rank Math, complete or skip its setup wizard). Relaunch72 verifies the sitemap that is actually served.' );
		}
		if ( '0' === (string) get_option( 'blog_public' ) ) {
			$warnings[] = array( 'code' => 'discourage_search', 'message' => '"Discourage search engines from indexing this site" is on. Posts can still be published, but sitemaps and search visibility are reduced. Relaunch72 does not change this setting.' );
		}
		if ( ! current_theme_supports( 'title-tag' ) && ! ( function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() ) && 'standalone' === $seo['mode'] ) {
			$warnings[] = array( 'code' => 'theme_title_tag', 'message' => 'The active theme does not declare title-tag support, so the standalone SEO title may not be used by the theme.' );
		}
		return array(
			'blocking' => $blocking,
			'warnings' => $warnings,
			'seo'      => $seo,
			'sitemap'  => $sitemap,
		);
	}

	/**
	 * Capabilities for the Relaunch72 v2 contract, or null if a blocking issue exists.
	 * capabilitiesSha changes whenever a URL-relevant fact changes, which makes
	 * Relaunch72 ask the owner to re-review targets instead of guessing.
	 */
	public static function capabilities() {
		$eval = self::evaluate();
		if ( ! empty( $eval['blocking'] ) ) {
			return null;
		}
		$settings = R72Pub_Settings::get();
		$root     = self::root_path();
		$index    = self::index();
		$caps     = array(
			'contractVersion' => 2,
			'urlContract'     => R72PUB_URL_CONTRACT,
			'siteId'          => R72Pub_Settings::site_id(),
			'publicOrigin'    => self::origin(),
			'roots'           => array(
				array(
					'id'                 => $root,
					'path'               => $root,
					'indexUrl'           => $index['url'],
					'articleUrlPattern'  => self::article_pattern(),
					'categoryUrlPattern' => self::category_pattern(),
				),
			),
			'taxonomy'        => array(
				'mode'                    => 'categories',
				'maxCategoriesPerArticle' => $settings['max_categories'],
			),
			'sitemaps'        => array( $eval['sitemap']['url'] ),
			'updates'         => array( 'preservePublishedUrl' => true ),
			'repair'          => array( 'sitemap' => false ),
		);
		$caps['capabilitiesSha'] = hash( 'sha256', wp_json_encode( self::canonical( $caps ) ) );
		return $caps;
	}

	public static function canonical( $value ) {
		if ( is_array( $value ) ) {
			$is_list = array_keys( $value ) === range( 0, count( $value ) - 1 );
			if ( ! $is_list ) {
				ksort( $value );
			}
			foreach ( $value as $k => $v ) {
				$value[ $k ] = self::canonical( $v );
			}
		}
		return $value;
	}
}
