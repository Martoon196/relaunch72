<?php
/**
 * SEO ownership: exactly one component owns canonical, robots, metadata, schema and
 * sitemap output.
 *
 *   Yoast SEO active alone   → mode "yoast":      values written to Yoast's own per-post fields; Yoast renders.
 *   Rank Math active alone   → mode "rank_math":  values written to Rank Math's own per-post fields; Rank Math renders.
 *   No SEO plugin active     → mode "standalone": this plugin renders description, robots, Open Graph,
 *                                                  Twitter and Article JSON-LD; WordPress core renders the
 *                                                  canonical and the core sitemap.
 *   Content-only (opt-in)    → mode "content_only": no SEO values written or rendered; the site keeps its own.
 *   Anything else            → mode "hold":       another or several SEO plugins are active. Publishing is
 *                                                  refused with an explanation, never half-applied.
 *
 * This plugin never deactivates another plugin and never edits another plugin's settings.
 * Human-authored per-post values are preserved: a field changed in WordPress after
 * Relaunch72 wrote it is not overwritten again.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Seo {
	const META_SEO      = '_r72_seo';
	const META_WRITTEN  = '_r72_seo_written';
	const META_PRESERVE = '_r72_seo_preserved';

	/** Active SEO plugins, detected from their published version constants/classes. */
	public static function active_plugins() {
		$found = array();
		if ( defined( 'WPSEO_VERSION' ) ) {
			$found['yoast'] = 'Yoast SEO ' . WPSEO_VERSION;
		}
		if ( defined( 'RANK_MATH_VERSION' ) ) {
			$found['rank_math'] = 'Rank Math ' . RANK_MATH_VERSION;
		}
		if ( defined( 'AIOSEO_VERSION' ) ) {
			$found['aioseo'] = 'All in One SEO ' . AIOSEO_VERSION;
		}
		if ( defined( 'SEOPRESS_VERSION' ) ) {
			$found['seopress'] = 'SEOPress ' . SEOPRESS_VERSION;
		}
		if ( defined( 'THE_SEO_FRAMEWORK_VERSION' ) ) {
			$found['the_seo_framework'] = 'The SEO Framework ' . THE_SEO_FRAMEWORK_VERSION;
		}
		if ( defined( 'SQ_VERSION' ) ) {
			$found['squirrly'] = 'Squirrly SEO ' . SQ_VERSION;
		}
		if ( defined( 'SLIM_SEO_VER' ) ) {
			$found['slim_seo'] = 'Slim SEO ' . SLIM_SEO_VER;
		}
		return $found;
	}

	/** @return array{mode:string,provider:string,active:array,message:string} */
	public static function status() {
		$active   = self::active_plugins();
		$settings = R72Pub_Settings::get();
		$names    = implode( ', ', array_values( $active ) );
		if ( 'content_only' === $settings['seo_mode'] ) {
			return array( 'mode' => 'content_only', 'provider' => $active ? $names : 'theme/WordPress core', 'active' => $active, 'message' => 'Content-only mode: Relaunch72 sends articles but writes and renders no SEO values. The site\'s existing SEO setup owns all output.' );
		}
		if ( ! $active ) {
			return array( 'mode' => 'standalone', 'provider' => 'Relaunch72 Publisher (standalone)', 'active' => $active, 'message' => 'No SEO plugin is active. This plugin renders article metadata, robots, social previews and Article schema; WordPress core renders the canonical and sitemap.' );
		}
		if ( 1 === count( $active ) && isset( $active['yoast'] ) ) {
			return array( 'mode' => 'yoast', 'provider' => $names, 'active' => $active, 'message' => 'Yoast SEO owns SEO output. Relaunch72 writes each managed article\'s values into Yoast\'s own fields.' );
		}
		if ( 1 === count( $active ) && isset( $active['rank_math'] ) ) {
			return array( 'mode' => 'rank_math', 'provider' => $names, 'active' => $active, 'message' => 'Rank Math owns SEO output. Relaunch72 writes each managed article\'s values into Rank Math\'s own fields.' );
		}
		if ( count( $active ) > 1 ) {
			return array( 'mode' => 'hold', 'provider' => $names, 'active' => $active, 'message' => 'More than one SEO plugin is active (' . $names . '), so canonical, robots and schema output may conflict. Publishing is held. Keep one SEO plugin active, or choose Content-only mode after checking the public output. Relaunch72 will not deactivate plugins.' );
		}
		return array( 'mode' => 'hold', 'provider' => $names, 'active' => $active, 'message' => $names . ' is active. Relaunch72 supports Yoast SEO and Rank Math integrations or standalone mode. Publishing is held; choose Content-only mode in Settings → Relaunch72 Publisher to let ' . $names . ' own all SEO output.' );
	}

	/** The sitemap that is actually responsible for post URLs, with its owner. */
	public static function sitemap() {
		$mode = self::status()['mode'];
		if ( 'yoast' === $mode && class_exists( 'WPSEO_Options' ) && WPSEO_Options::get( 'enable_xml_sitemap' ) ) {
			return array( 'owner' => 'yoast', 'url' => home_url( '/sitemap_index.xml' ), 'message' => 'Yoast SEO serves the XML sitemap.' );
		}
		if ( 'rank_math' === $mode ) {
			$modules = get_option( 'rank_math_modules', array() );
			if ( is_array( $modules ) && in_array( 'sitemap', $modules, true ) ) {
				return array( 'owner' => 'rank_math', 'url' => home_url( '/sitemap_index.xml' ), 'message' => 'Rank Math serves the XML sitemap.' );
			}
		}
		if ( function_exists( 'wp_sitemaps_get_server' ) ) {
			$server = wp_sitemaps_get_server();
			if ( $server && $server->sitemaps_enabled() ) {
				return array( 'owner' => 'core', 'url' => home_url( '/wp-sitemap.xml' ), 'message' => 'WordPress core serves the XML sitemap.' );
			}
		}
		return array( 'owner' => 'none', 'url' => '', 'message' => 'No XML sitemap is being served for posts (the SEO plugin\'s sitemap and WordPress core sitemaps are both off). Enable one sitemap owner; Relaunch72 does not change this setting.' );
	}

	// ─── Per-article values ─────────────────────────────────────────────────

	/**
	 * Normalised, validated SEO intent for one managed article version.
	 * Canonical is always the reviewed target URL (one effective canonical).
	 */
	public static function intent_from_payload( array $p, $canonical ) {
		$wp     = isset( $p['wordpress'] ) && is_array( $p['wordpress'] ) ? $p['wordpress'] : array();
		$robots = isset( $wp['robots'] ) && is_array( $wp['robots'] ) ? $wp['robots'] : array();
		$social = isset( $wp['social'] ) && is_array( $wp['social'] ) ? $wp['social'] : array();
		$cites  = array();
		foreach ( ( isset( $wp['citations'] ) && is_array( $wp['citations'] ) ) ? array_slice( $wp['citations'], 0, 50 ) : array() as $c ) {
			if ( is_array( $c ) && isset( $c['url'] ) && is_string( $c['url'] ) && wp_http_validate_url( $c['url'] ) ) {
				$cites[] = array( 'url' => esc_url_raw( $c['url'] ), 'title' => isset( $c['title'] ) ? sanitize_text_field( (string) $c['title'] ) : '' );
			}
		}
		$title = sanitize_text_field( (string) ( $p['seoTitle'] ?? $p['title'] ?? '' ) );
		$desc  = sanitize_text_field( (string) ( $p['metaDescription'] ?? $p['excerpt'] ?? '' ) );
		return array(
			'title'       => mb_substr( $title, 0, 200 ),
			'description' => mb_substr( $desc, 0, 400 ),
			'canonical'   => $canonical,
			'index'       => ! isset( $robots['index'] ) || true === $robots['index'],
			'follow'      => ! isset( $robots['follow'] ) || true === $robots['follow'],
			'socialTitle' => mb_substr( sanitize_text_field( (string) ( $social['title'] ?? $title ) ), 0, 200 ),
			'socialDescription' => mb_substr( sanitize_text_field( (string) ( $social['description'] ?? $desc ) ), 0, 400 ),
			'author'      => isset( $p['author']['name'] ) && is_string( $p['author']['name'] ) ? sanitize_text_field( $p['author']['name'] ) : '',
			'locale'      => isset( $p['locale'] ) && is_string( $p['locale'] ) ? sanitize_text_field( $p['locale'] ) : '',
			'citations'   => $cites,
		);
	}

	/** Provider field values for the active mode. */
	private static function provider_values( $mode, array $intent, $image_id, $image_url ) {
		if ( 'yoast' === $mode ) {
			return array(
				'_yoast_wpseo_title'                   => $intent['title'],
				'_yoast_wpseo_metadesc'                => $intent['description'],
				// Empty = Yoast's own site default; only an explicit noindex/nofollow is written.
				'_yoast_wpseo_meta-robots-noindex'     => $intent['index'] ? '' : '1',
				'_yoast_wpseo_meta-robots-nofollow'    => $intent['follow'] ? '' : '1',
				'_yoast_wpseo_opengraph-title'         => $intent['socialTitle'],
				'_yoast_wpseo_opengraph-description'   => $intent['socialDescription'],
				'_yoast_wpseo_opengraph-image'         => $image_url,
				'_yoast_wpseo_opengraph-image-id'      => $image_id ? (string) $image_id : '',
				'_yoast_wpseo_twitter-title'           => $intent['socialTitle'],
				'_yoast_wpseo_twitter-description'     => $intent['socialDescription'],
			);
		}
		if ( 'rank_math' === $mode ) {
			return array(
				'rank_math_title'                 => $intent['title'],
				'rank_math_description'           => $intent['description'],
				// Empty = Rank Math's own site default; only an explicit noindex/nofollow is written.
				'rank_math_robots'                => ( $intent['index'] && $intent['follow'] ) ? array() : array( $intent['index'] ? 'index' : 'noindex', $intent['follow'] ? 'follow' : 'nofollow' ),
				'rank_math_facebook_title'        => $intent['socialTitle'],
				'rank_math_facebook_description'  => $intent['socialDescription'],
				'rank_math_facebook_image'        => $image_url,
				'rank_math_facebook_image_id'     => $image_id ? (string) $image_id : '',
				'rank_math_twitter_use_facebook'  => 'on',
			);
		}
		return array();
	}

	/**
	 * Store the intent and write provider fields, preserving any field a person changed
	 * after Relaunch72 last wrote it (or that a person had set before Relaunch72 managed it).
	 *
	 * @return array{mode:string,written:string[],preserved:string[]}
	 */
	public static function apply( $post_id, array $intent, $image_id, $image_url ) {
		$mode = self::status()['mode'];
		update_post_meta( $post_id, self::META_SEO, wp_slash( wp_json_encode( $intent ) ) );
		$values   = self::provider_values( $mode, $intent, $image_id, $image_url );
		$previous = json_decode( (string) get_post_meta( $post_id, self::META_WRITTEN, true ), true );
		$previous = is_array( $previous ) ? $previous : array();
		$written  = $previous;
		$done     = array();
		$kept     = array();
		foreach ( $values as $key => $value ) {
			$current = get_post_meta( $post_id, $key, true );
			$ours    = array_key_exists( $key, $previous ) ? $previous[ $key ] : null;
			$human   = ( null === $ours ) ? ( '' !== $current && array() !== $current && null !== $current ) : ( self::norm( $current ) !== self::norm( $ours ) );
			if ( $human ) {
				$kept[] = $key;
				unset( $written[ $key ] );
				continue;
			}
			if ( '' === $value || array() === $value ) {
				delete_post_meta( $post_id, $key );
			} else {
				update_post_meta( $post_id, $key, is_array( $value ) ? $value : wp_slash( $value ) );
			}
			$written[ $key ] = $value;
			$done[]          = $key;
		}
		update_post_meta( $post_id, self::META_WRITTEN, wp_slash( wp_json_encode( $written ) ) );
		update_post_meta( $post_id, self::META_PRESERVE, wp_slash( wp_json_encode( $kept ) ) );
		return array( 'mode' => $mode, 'written' => $done, 'preserved' => $kept );
	}

	private static function norm( $v ) {
		if ( is_array( $v ) ) {
			return wp_json_encode( array_values( $v ) );
		}
		return (string) $v;
	}

	public static function intent( $post_id ) {
		$v = json_decode( (string) get_post_meta( $post_id, self::META_SEO, true ), true );
		return is_array( $v ) ? $v : null;
	}

	// ─── Front end ──────────────────────────────────────────────────────────

	public static function register_frontend() {
		add_action( 'wp_head', array( __CLASS__, 'version_marker' ), 1 );
		if ( 'standalone' !== self::status()['mode'] ) {
			return;
		}
		add_filter( 'pre_get_document_title', array( __CLASS__, 'document_title' ), 20 );
		add_filter( 'wp_robots', array( __CLASS__, 'robots' ), 20 );
		add_action( 'wp_head', array( __CLASS__, 'standalone_head' ), 2 );
	}

	/** The managed, published post being viewed, or null. */
	private static function current_managed() {
		if ( ! is_singular( 'post' ) ) {
			return null;
		}
		$post = get_queried_object();
		if ( ! $post instanceof WP_Post || 'publish' !== $post->post_status || '' === (string) get_post_meta( $post->ID, R72Pub_Publisher::META_ARTICLE, true ) ) {
			return null;
		}
		return $post;
	}

	/** Exactly one exact-version marker, on the managed article page only. */
	public static function version_marker() {
		$post = self::current_managed();
		if ( ! $post ) {
			return;
		}
		$marker = (string) get_post_meta( $post->ID, R72Pub_Publisher::META_MARKER, true );
		if ( preg_match( '/^r72-blog:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{16}$/', $marker ) ) {
			echo '<meta name="r72-blog-version" content="' . esc_attr( $marker ) . '" />' . "\n";
		}
	}

	public static function document_title( $title ) {
		$post = self::current_managed();
		if ( $post ) {
			$intent = self::intent( $post->ID );
			if ( $intent && '' !== $intent['title'] ) {
				return $intent['title'];
			}
			return $title;
		}
		$site = R72Pub_Settings::site_seo();
		if ( ! empty( $site['apply_templates'] ) && '' !== $site['title_template'] && is_singular() ) {
			return self::render_template( $site['title_template'], get_queried_object() );
		}
		return $title;
	}

	public static function render_template( $template, $post ) {
		$title = $post instanceof WP_Post ? get_the_title( $post ) : wp_get_document_title();
		return trim( str_replace( array( '%title%', '%sitename%', '%sep%' ), array( wp_strip_all_tags( $title ), get_bloginfo( 'name' ), '|' ), $template ) );
	}

	public static function robots( array $robots ) {
		$post = self::current_managed();
		if ( ! $post ) {
			return $robots;
		}
		$intent = self::intent( $post->ID );
		if ( ! $intent ) {
			return $robots;
		}
		if ( ! $intent['index'] ) {
			$robots['noindex'] = true;
			unset( $robots['max-image-preview'] );
		}
		if ( ! $intent['follow'] ) {
			$robots['nofollow'] = true;
		}
		return $robots;
	}

	public static function standalone_head() {
		$post = self::current_managed();
		$site = R72Pub_Settings::site_seo();
		if ( ! $post ) {
			if ( is_front_page() && ! empty( $site['organization_schema'] ) && '' !== $site['organization_name'] ) {
				$org = array( '@context' => 'https://schema.org', '@type' => 'Organization', 'name' => $site['organization_name'], 'url' => home_url( '/' ) );
				if ( '' !== $site['logo_url'] ) {
					$org['logo'] = $site['logo_url'];
				}
				if ( $site['social_profiles'] ) {
					$org['sameAs'] = array_values( $site['social_profiles'] );
				}
				echo '<script type="application/ld+json">' . wp_json_encode( $org, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP ) . "</script>\n";
			}
			if ( ! empty( $site['apply_templates'] ) && '' !== $site['default_description'] && ( is_front_page() || is_home() ) ) {
				echo '<meta name="description" content="' . esc_attr( $site['default_description'] ) . '" />' . "\n";
			}
			return;
		}
		$intent = self::intent( $post->ID );
		if ( ! $intent ) {
			return;
		}
		$canonical = (string) get_post_meta( $post->ID, R72Pub_Publisher::META_CANONICAL, true );
		$image_id  = (int) get_post_thumbnail_id( $post->ID );
		$image     = $image_id ? wp_get_attachment_image_src( $image_id, 'full' ) : false;
		$alt       = $image_id ? (string) get_post_meta( $image_id, '_wp_attachment_image_alt', true ) : '';
		$out       = array();
		if ( '' !== $intent['description'] ) {
			$out[] = '<meta name="description" content="' . esc_attr( $intent['description'] ) . '" />';
		}
		$og = array(
			'og:type'                => 'article',
			'og:title'               => $intent['socialTitle'],
			'og:description'         => $intent['socialDescription'],
			'og:url'                 => $canonical,
			'og:site_name'           => get_bloginfo( 'name' ),
			'article:published_time' => get_post_time( 'c', true, $post ),
			'article:modified_time'  => get_post_modified_time( 'c', true, $post ),
		);
		if ( '' !== $intent['locale'] ) {
			$og['og:locale'] = str_replace( '-', '_', $intent['locale'] );
		}
		if ( $image ) {
			$og['og:image'] = $image[0];
			$og['og:image:width'] = (string) $image[1];
			$og['og:image:height'] = (string) $image[2];
			if ( '' !== $alt ) {
				$og['og:image:alt'] = $alt;
			}
		}
		foreach ( $og as $property => $content ) {
			if ( '' !== (string) $content ) {
				$out[] = '<meta property="' . esc_attr( $property ) . '" content="' . esc_attr( $content ) . '" />';
			}
		}
		$tw = array(
			'twitter:card'        => $image ? 'summary_large_image' : 'summary',
			'twitter:title'       => $intent['socialTitle'],
			'twitter:description' => $intent['socialDescription'],
		);
		if ( $image ) {
			$tw['twitter:image'] = $image[0];
			if ( '' !== $alt ) {
				$tw['twitter:image:alt'] = $alt;
			}
		}
		foreach ( $tw as $name => $content ) {
			if ( '' !== (string) $content ) {
				$out[] = '<meta name="' . esc_attr( $name ) . '" content="' . esc_attr( $content ) . '" />';
			}
		}
		$out[] = '<script type="application/ld+json">' . wp_json_encode( self::article_schema( $post, $intent, $canonical, $image, $site ), JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP ) . '</script>';
		echo implode( "\n", $out ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- every value escaped above.
	}

	/** Factual Article data only: values that exist on the post or in reviewed site identity. */
	public static function article_schema( WP_Post $post, array $intent, $canonical, $image, array $site ) {
		$publisher = '' !== $site['organization_name'] ? $site['organization_name'] : get_bloginfo( 'name' );
		$schema    = array(
			'@context'         => 'https://schema.org',
			'@type'            => 'Article',
			'headline'         => mb_substr( wp_strip_all_tags( get_the_title( $post ) ), 0, 110 ),
			'description'      => $intent['description'],
			'datePublished'    => get_post_time( 'c', true, $post ),
			'dateModified'     => get_post_modified_time( 'c', true, $post ),
			'mainEntityOfPage' => array( '@type' => 'WebPage', '@id' => $canonical ),
			'url'              => $canonical,
			'publisher'        => array( '@type' => 'Organization', 'name' => $publisher ),
		);
		if ( '' !== $site['logo_url'] ) {
			$schema['publisher']['logo'] = array( '@type' => 'ImageObject', 'url' => $site['logo_url'] );
		}
		if ( '' !== $intent['author'] ) {
			$schema['author'] = array( '@type' => 'Person', 'name' => $intent['author'] );
		} else {
			$schema['author'] = array( '@type' => 'Organization', 'name' => $publisher );
		}
		if ( $image ) {
			$schema['image'] = array( '@type' => 'ImageObject', 'url' => $image[0], 'width' => (int) $image[1], 'height' => (int) $image[2] );
		}
		if ( '' !== $intent['locale'] ) {
			$schema['inLanguage'] = $intent['locale'];
		}
		if ( $intent['citations'] ) {
			$schema['citation'] = array_map(
				function ( $c ) {
					return array_filter( array( '@type' => 'CreativeWork', 'url' => $c['url'], 'name' => $c['title'] ) );
				},
				$intent['citations']
			);
		}
		return $schema;
	}
}
