<?php
/**
 * SEO ownership and output.
 *
 * Exactly one component owns canonical, robots, metadata, schema and the sitemap:
 *
 *   Yoast SEO active alone   → mode "yoast":      managed-article values are written to Yoast's own
 *                                                  per-post fields; Yoast renders everything.
 *   Rank Math active alone   → mode "rank_math":  same, with Rank Math's fields.
 *   No SEO plugin active     → mode "standalone": this plugin is the site's SEO plugin. Per-post fields
 *                                                  (SEO title, description, canonical, robots, social)
 *                                                  are editable on every post and page, and the
 *                                                  site-wide settings (title templates, descriptions,
 *                                                  robots defaults, social defaults, knowledge graph,
 *                                                  sitemap) apply once "Site-wide output" is switched on.
 *   Content-only (opt-in)    → mode "content_only": no SEO values written, nothing rendered.
 *   Anything else            → mode "hold":       another or several SEO plugins are active. Relaunch72
 *                                                  delivery is refused with an explanation.
 *
 * This plugin never deactivates another plugin and never edits another plugin's settings.
 * A per-post field changed by a person after Relaunch72 wrote it is preserved on later updates.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Seo {
	/** Relaunch72 provenance blob (author, locale, public citations) for managed posts. */
	const META_SEO      = '_r72_seo';
	const META_WRITTEN  = '_r72_seo_written';
	const META_PRESERVE = '_r72_seo_preserved';

	/** Standalone per-post fields, editable by people in the SEO box. */
	const F_TITLE       = '_r72_seo_title';
	const F_DESC        = '_r72_seo_description';
	const F_CANONICAL   = '_r72_seo_canonical';
	const F_NOINDEX     = '_r72_seo_noindex';
	const F_NOFOLLOW    = '_r72_seo_nofollow';
	const F_OG_TITLE    = '_r72_seo_og_title';
	const F_OG_DESC     = '_r72_seo_og_description';
	const F_OG_IMAGE    = '_r72_seo_og_image_id';

	public static function fields() {
		return array( self::F_TITLE, self::F_DESC, self::F_CANONICAL, self::F_NOINDEX, self::F_NOFOLLOW, self::F_OG_TITLE, self::F_OG_DESC, self::F_OG_IMAGE );
	}

	// ─── Detection ──────────────────────────────────────────────────────────

	/** Active SEO plugins, detected from their published version constants. */
	public static function active_plugins() {
		$known = array(
			'yoast'             => array( 'WPSEO_VERSION', 'Yoast SEO' ),
			'rank_math'         => array( 'RANK_MATH_VERSION', 'Rank Math' ),
			'aioseo'            => array( 'AIOSEO_VERSION', 'All in One SEO' ),
			'seopress'          => array( 'SEOPRESS_VERSION', 'SEOPress' ),
			'the_seo_framework' => array( 'THE_SEO_FRAMEWORK_VERSION', 'The SEO Framework' ),
			'squirrly'          => array( 'SQ_VERSION', 'Squirrly SEO' ),
			'slim_seo'          => array( 'SLIM_SEO_VER', 'Slim SEO' ),
		);
		$found = array();
		foreach ( $known as $key => $def ) {
			if ( defined( $def[0] ) ) {
				$found[ $key ] = $def[1] . ' ' . constant( $def[0] );
			}
		}
		return $found;
	}

	/** @return array{mode:string,provider:string,active:array,message:string} */
	public static function status() {
		$active   = self::active_plugins();
		$settings = R72Pub_Settings::get();
		$names    = implode( ', ', array_values( $active ) );
		if ( 'content_only' === $settings['seo_mode'] ) {
			return array( 'mode' => 'content_only', 'provider' => $active ? $names : __( 'theme/WordPress core', 'relaunch72-publisher' ), 'active' => $active, 'message' => __( 'Content-only mode: Relaunch72 sends articles but writes and renders no SEO values. The site\'s existing SEO setup owns all output.', 'relaunch72-publisher' ) );
		}
		if ( ! $active ) {
			return array( 'mode' => 'standalone', 'provider' => __( 'Relaunch72 Publisher & SEO (standalone)', 'relaunch72-publisher' ), 'active' => $active, 'message' => __( 'No other SEO plugin is active, so this plugin is the site\'s SEO plugin: per-post SEO fields on every post and page, and site-wide titles, descriptions, robots, social previews, schema and sitemap controls.', 'relaunch72-publisher' ) );
		}
		if ( 1 === count( $active ) && isset( $active['yoast'] ) ) {
			return array( 'mode' => 'yoast', 'provider' => $names, 'active' => $active, 'message' => __( 'Yoast SEO owns SEO output. Relaunch72 writes each managed article\'s values into Yoast\'s own fields.', 'relaunch72-publisher' ) );
		}
		if ( 1 === count( $active ) && isset( $active['rank_math'] ) ) {
			return array( 'mode' => 'rank_math', 'provider' => $names, 'active' => $active, 'message' => __( 'Rank Math owns SEO output. Relaunch72 writes each managed article\'s values into Rank Math\'s own fields.', 'relaunch72-publisher' ) );
		}
		if ( count( $active ) > 1 ) {
			/* translators: %s: list of active SEO plugins */
			return array( 'mode' => 'hold', 'provider' => $names, 'active' => $active, 'message' => sprintf( __( 'More than one SEO plugin is active (%s), so canonical, robots and schema output may conflict. Relaunch72 publishing is held. Keep one SEO plugin active, or choose Content-only mode after checking the public output. Relaunch72 will not deactivate plugins.', 'relaunch72-publisher' ), $names ) );
		}
		/* translators: 1: active SEO plugin name, 2: same name */
		return array( 'mode' => 'hold', 'provider' => $names, 'active' => $active, 'message' => sprintf( __( '%1$s is active. Relaunch72 supports Yoast SEO and Rank Math integrations or standalone mode. Publishing is held; choose Content-only mode in Relaunch72 → Connection to let %2$s own all SEO output.', 'relaunch72-publisher' ), $names, $names ) );
	}

	/** The sitemap actually responsible for post URLs, with its owner. */
	public static function sitemap() {
		$mode = self::status()['mode'];
		if ( 'yoast' === $mode && class_exists( 'WPSEO_Options' ) && WPSEO_Options::get( 'enable_xml_sitemap' ) ) {
			return array( 'owner' => 'yoast', 'url' => home_url( '/sitemap_index.xml' ), 'message' => __( 'Yoast SEO serves the XML sitemap.', 'relaunch72-publisher' ) );
		}
		if ( 'rank_math' === $mode ) {
			$modules = get_option( 'rank_math_modules', array() );
			if ( is_array( $modules ) && in_array( 'sitemap', $modules, true ) ) {
				return array( 'owner' => 'rank_math', 'url' => home_url( '/sitemap_index.xml' ), 'message' => __( 'Rank Math serves the XML sitemap.', 'relaunch72-publisher' ) );
			}
		}
		if ( function_exists( 'wp_sitemaps_get_server' ) ) {
			$server = wp_sitemaps_get_server();
			if ( $server && $server->sitemaps_enabled() ) {
				return array( 'owner' => 'core', 'url' => home_url( '/wp-sitemap.xml' ), 'message' => __( 'WordPress core serves the XML sitemap.', 'relaunch72-publisher' ) );
			}
		}
		return array( 'owner' => 'none', 'url' => '', 'message' => __( 'No XML sitemap is being served for posts. Enable one sitemap owner (the SEO plugin\'s sitemap, or WordPress core sitemaps in Relaunch72 → SEO); Relaunch72 does not change this on its own.', 'relaunch72-publisher' ) );
	}

	// ─── Relaunch72-managed article values ──────────────────────────────────

	/** Normalised, validated SEO intent for one managed article version. Canonical is the reviewed target URL. */
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
			'title'             => mb_substr( $title, 0, 200 ),
			'description'       => mb_substr( $desc, 0, 400 ),
			'canonical'         => $canonical,
			'index'             => ! isset( $robots['index'] ) || true === $robots['index'],
			'follow'            => ! isset( $robots['follow'] ) || true === $robots['follow'],
			'socialTitle'       => mb_substr( sanitize_text_field( (string) ( $social['title'] ?? $title ) ), 0, 200 ),
			'socialDescription' => mb_substr( sanitize_text_field( (string) ( $social['description'] ?? $desc ) ), 0, 400 ),
			'author'            => isset( $p['author']['name'] ) && is_string( $p['author']['name'] ) ? sanitize_text_field( $p['author']['name'] ) : '',
			'locale'            => isset( $p['locale'] ) && is_string( $p['locale'] ) ? sanitize_text_field( $p['locale'] ) : '',
			'citations'         => $cites,
		);
	}

	/** Provider field values for the active mode. Empty = that provider's own site default. */
	private static function provider_values( $mode, array $intent, $image_id, $image_url ) {
		if ( 'yoast' === $mode ) {
			return array(
				'_yoast_wpseo_title'                 => $intent['title'],
				'_yoast_wpseo_metadesc'              => $intent['description'],
				'_yoast_wpseo_meta-robots-noindex'   => $intent['index'] ? '' : '1',
				'_yoast_wpseo_meta-robots-nofollow'  => $intent['follow'] ? '' : '1',
				'_yoast_wpseo_opengraph-title'       => $intent['socialTitle'],
				'_yoast_wpseo_opengraph-description' => $intent['socialDescription'],
				'_yoast_wpseo_opengraph-image'       => $image_url,
				'_yoast_wpseo_opengraph-image-id'    => $image_id ? (string) $image_id : '',
				'_yoast_wpseo_twitter-title'         => $intent['socialTitle'],
				'_yoast_wpseo_twitter-description'   => $intent['socialDescription'],
			);
		}
		if ( 'rank_math' === $mode ) {
			return array(
				'rank_math_title'                => $intent['title'],
				'rank_math_description'          => $intent['description'],
				'rank_math_robots'               => ( $intent['index'] && $intent['follow'] ) ? array() : array( $intent['index'] ? 'index' : 'noindex', $intent['follow'] ? 'follow' : 'nofollow' ),
				'rank_math_facebook_title'       => $intent['socialTitle'],
				'rank_math_facebook_description' => $intent['socialDescription'],
				'rank_math_facebook_image'       => $image_url,
				'rank_math_facebook_image_id'    => $image_id ? (string) $image_id : '',
				'rank_math_twitter_use_facebook' => 'on',
			);
		}
		if ( 'standalone' === $mode ) {
			return array(
				self::F_TITLE     => $intent['title'],
				self::F_DESC      => $intent['description'],
				self::F_CANONICAL => '', // The reviewed URL is the permalink; no override.
				self::F_NOINDEX   => $intent['index'] ? '' : '1',
				self::F_NOFOLLOW  => $intent['follow'] ? '' : '1',
				self::F_OG_TITLE  => $intent['socialTitle'],
				self::F_OG_DESC   => $intent['socialDescription'],
				self::F_OG_IMAGE  => '', // Featured image is used.
			);
		}
		return array();
	}

	/**
	 * Store the provenance and write the active mode's per-post fields, preserving any field a
	 * person changed after Relaunch72 last wrote it (or had set before Relaunch72 managed it).
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
		return is_array( $v ) ? wp_json_encode( array_values( $v ) ) : (string) $v;
	}

	public static function intent( $post_id ) {
		$v = json_decode( (string) get_post_meta( $post_id, self::META_SEO, true ), true );
		return is_array( $v ) ? $v : null;
	}

	// ─── Front end (standalone mode) ────────────────────────────────────────

	public static function register_frontend() {
		add_action( 'wp_head', array( __CLASS__, 'version_marker' ), 1 );
		if ( 'standalone' !== self::status()['mode'] ) {
			return;
		}
		add_filter( 'pre_get_document_title', array( __CLASS__, 'document_title' ), 20 );
		add_filter( 'wp_robots', array( __CLASS__, 'robots' ), 20 );
		add_action( 'wp_head', array( __CLASS__, 'head' ), 2 );
		add_filter( 'wp_sitemaps_enabled', array( __CLASS__, 'sitemaps_enabled' ) );
		add_filter( 'wp_sitemaps_posts_query_args', array( __CLASS__, 'sitemap_exclude_noindex' ) );
		add_action( 'template_redirect', array( __CLASS__, 'maybe_replace_core_canonical' ) );
	}

	public static function site() {
		return R72Pub_Settings::site_seo();
	}

	/** Site-wide standalone output is an explicit switch; before it, only managed posts are touched. */
	public static function site_wide() {
		return ! empty( self::site()['site_wide'] );
	}

	private static function managed( $post ) {
		return $post instanceof WP_Post && '' !== (string) get_post_meta( $post->ID, R72Pub_Publisher::META_ARTICLE, true );
	}

	/** A person set at least one SEO field on this post. Explicit per-post values always apply. */
	private static function has_own_values( WP_Post $post ) {
		foreach ( self::fields() as $key ) {
			if ( '' !== (string) get_post_meta( $post->ID, $key, true ) ) {
				return true;
			}
		}
		return false;
	}

	/** The post this plugin is responsible for on this request, or null. */
	private static function current_post() {
		if ( ! is_singular() ) {
			return null;
		}
		$post = get_queried_object();
		if ( ! $post instanceof WP_Post ) {
			return null;
		}
		if ( ! self::site_wide() && ! self::managed( $post ) && ! self::has_own_values( $post ) ) {
			return null;
		}
		return $post;
	}

	/** Exactly one exact-version marker, on the managed article page only. */
	public static function version_marker() {
		if ( ! is_singular( 'post' ) ) {
			return;
		}
		$post = get_queried_object();
		if ( ! self::managed( $post ) || 'publish' !== $post->post_status ) {
			return;
		}
		$marker = (string) get_post_meta( $post->ID, R72Pub_Publisher::META_MARKER, true );
		if ( preg_match( '/^r72-blog:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{16}$/', $marker ) ) {
			echo '<meta name="r72-blog-version" content="' . esc_attr( $marker ) . '" />' . "\n";
		}
	}

	// ─── Templates ──────────────────────────────────────────────────────────

	public static function template_variables() {
		return array(
			'%title%'            => __( 'Post, page or archive title', 'relaunch72-publisher' ),
			'%sitename%'         => __( 'Site title', 'relaunch72-publisher' ),
			'%tagline%'          => __( 'Site tagline', 'relaunch72-publisher' ),
			'%sep%'              => __( 'Title separator', 'relaunch72-publisher' ),
			'%term%'             => __( 'Category, tag or term name', 'relaunch72-publisher' ),
			'%term_description%' => __( 'Category, tag or term description', 'relaunch72-publisher' ),
			'%excerpt%'          => __( 'Post excerpt (manual excerpt only)', 'relaunch72-publisher' ),
			'%page%'             => __( '"Page N" on paginated archives, otherwise empty', 'relaunch72-publisher' ),
			'%search%'           => __( 'Search phrase', 'relaunch72-publisher' ),
		);
	}

	/** Render a template for the given context; collapses empty separators. */
	public static function render_template( $template, array $vars, $site = null ) {
		$site = is_array( $site ) ? $site : self::site();
		$vars = array_merge(
			array(
				'%sitename%' => get_bloginfo( 'name' ),
				'%tagline%'  => get_bloginfo( 'description' ),
				'%sep%'      => $site['separator'],
			),
			$vars
		);
		$out = str_replace( array_keys( $vars ), array_values( $vars ), $template );
		$sep = preg_quote( $site['separator'], '/' );
		$out = preg_replace( '/(\s*' . $sep . '\s*){2,}/u', ' ' . $site['separator'] . ' ', $out );
		$out = preg_replace( '/^\s*' . $sep . '\s*|\s*' . $sep . '\s*$/u', '', $out );
		return trim( preg_replace( '/\s+/u', ' ', wp_strip_all_tags( $out ) ) );
	}

	private static function page_var() {
		$paged = max( (int) get_query_var( 'paged' ), (int) get_query_var( 'page' ) );
		/* translators: %d: page number */
		return $paged > 1 ? sprintf( __( 'Page %d', 'relaunch72-publisher' ), $paged ) : '';
	}

	/** Variables for the current (or a given) context. */
	public static function context_vars( $post = null ) {
		$vars = array( '%page%' => self::page_var(), '%term%' => '', '%term_description%' => '', '%excerpt%' => '', '%search%' => '', '%title%' => '' );
		if ( $post instanceof WP_Post ) {
			$vars['%title%']   = wp_strip_all_tags( get_the_title( $post ) );
			$vars['%excerpt%'] = has_excerpt( $post ) ? wp_strip_all_tags( $post->post_excerpt ) : '';
		} elseif ( is_category() || is_tag() || is_tax() ) {
			$term                       = get_queried_object();
			$vars['%title%']            = $term ? wp_strip_all_tags( $term->name ) : '';
			$vars['%term%']             = $vars['%title%'];
			$vars['%term_description%'] = $term ? wp_strip_all_tags( term_description( $term ) ) : '';
		} elseif ( is_author() ) {
			$vars['%title%'] = wp_strip_all_tags( get_the_author_meta( 'display_name', (int) get_query_var( 'author' ) ) );
		} elseif ( is_search() ) {
			$vars['%search%'] = get_search_query();
			$vars['%title%']  = $vars['%search%'];
		} elseif ( is_home() && ! is_front_page() ) {
			$vars['%title%'] = wp_strip_all_tags( get_the_title( (int) get_option( 'page_for_posts' ) ) );
		} elseif ( is_post_type_archive() ) {
			$vars['%title%'] = wp_strip_all_tags( post_type_archive_title( '', false ) );
		} elseif ( is_date() ) {
			$vars['%title%'] = wp_strip_all_tags( get_the_archive_title() );
		}
		return $vars;
	}

	private static function template_key_for_context() {
		if ( is_front_page() || is_home() ) {
			return 'title_home';
		}
		if ( is_singular( 'page' ) ) {
			return 'title_page';
		}
		if ( is_singular() ) {
			return 'title_post';
		}
		if ( is_search() ) {
			return 'title_search';
		}
		if ( is_404() ) {
			return 'title_404';
		}
		return 'title_archive';
	}

	// ─── Computed values ────────────────────────────────────────────────────

	public static function document_title( $title ) {
		$post = self::current_post();
		if ( $post ) {
			$own = (string) get_post_meta( $post->ID, self::F_TITLE, true );
			if ( '' !== $own ) {
				return apply_filters( 'r72pub_document_title', $own, $post );
			}
			if ( ! self::site_wide() ) {
				return $title;
			}
		} elseif ( ! self::site_wide() ) {
			return $title;
		}
		$key      = self::template_key_for_context();
		$template = (string) self::site()[ $key ];
		if ( '' === $template ) {
			return $title;
		}
		return apply_filters( 'r72pub_document_title', self::render_template( $template, self::context_vars( $post ) ), $post );
	}

	public static function description() {
		$post = self::current_post();
		if ( $post ) {
			$own = (string) get_post_meta( $post->ID, self::F_DESC, true );
			if ( '' === $own && self::site_wide() && is_front_page() ) {
				$own = self::render_template( self::site()['desc_home'], self::context_vars() ); // Static front page.
			}
			return apply_filters( 'r72pub_meta_description', $own, $post );
		}
		if ( ! self::site_wide() ) {
			return '';
		}
		$site = self::site();
		if ( is_front_page() || is_home() ) {
			return apply_filters( 'r72pub_meta_description', self::render_template( $site['desc_home'], self::context_vars() ), null );
		}
		if ( is_category() || is_tag() || is_tax() ) {
			return apply_filters( 'r72pub_meta_description', self::render_template( $site['desc_archive'], self::context_vars() ), null );
		}
		return '';
	}

	public static function canonical() {
		$post = self::current_post();
		if ( $post ) {
			$override = (string) get_post_meta( $post->ID, self::F_CANONICAL, true );
			return apply_filters( 'r72pub_canonical', '' !== $override ? $override : wp_get_canonical_url( $post ), $post );
		}
		if ( ! self::site_wide() || is_404() || is_search() ) {
			return '';
		}
		$paged = max( 1, (int) get_query_var( 'paged' ) );
		if ( is_front_page() ) {
			$url = $paged > 1 ? get_pagenum_link( $paged ) : home_url( '/' );
		} elseif ( is_home() ) {
			$url = $paged > 1 ? get_pagenum_link( $paged ) : get_permalink( (int) get_option( 'page_for_posts' ) );
		} elseif ( is_category() || is_tag() || is_tax() ) {
			$url = get_term_link( get_queried_object() );
			if ( is_wp_error( $url ) ) {
				return '';
			}
			if ( $paged > 1 ) {
				$url = get_pagenum_link( $paged );
			}
		} elseif ( is_author() || is_post_type_archive() || is_date() ) {
			$url = $paged > 1 ? get_pagenum_link( $paged ) : ( is_author() ? get_author_posts_url( (int) get_query_var( 'author' ) ) : ( is_post_type_archive() ? get_post_type_archive_link( get_post_type() ) : get_pagenum_link( 1 ) ) );
		} else {
			return '';
		}
		return apply_filters( 'r72pub_canonical', is_string( $url ) ? $url : '', null );
	}

	/** When a post has a canonical override, this plugin's canonical replaces core's. One tag only. */
	public static function maybe_replace_core_canonical() {
		$post = self::current_post();
		if ( $post && '' !== (string) get_post_meta( $post->ID, self::F_CANONICAL, true ) ) {
			remove_action( 'wp_head', 'rel_canonical' );
		}
	}

	public static function robots( array $robots ) {
		$post = self::current_post();
		if ( $post ) {
			if ( '1' === (string) get_post_meta( $post->ID, self::F_NOINDEX, true ) ) {
				$robots['noindex'] = true;
				unset( $robots['max-image-preview'] );
			}
			if ( '1' === (string) get_post_meta( $post->ID, self::F_NOFOLLOW, true ) ) {
				$robots['nofollow'] = true;
			}
			return apply_filters( 'r72pub_robots', $robots, $post );
		}
		if ( ! self::site_wide() ) {
			return $robots;
		}
		$site    = self::site();
		$noindex = ( is_category() && $site['noindex_category'] ) || ( is_tag() && $site['noindex_tag'] ) || ( is_author() && $site['noindex_author'] ) || ( is_date() && $site['noindex_date'] ) || ( is_search() && $site['noindex_search'] ) || ( is_paged() && $site['noindex_paged'] );
		if ( $noindex ) {
			$robots['noindex'] = true;
			$robots['follow']  = true;
			unset( $robots['max-image-preview'] );
		}
		return apply_filters( 'r72pub_robots', $robots, null );
	}

	public static function sitemaps_enabled( $enabled ) {
		$setting = self::site()['core_sitemap'];
		return 'on' === $setting ? true : ( 'off' === $setting ? false : $enabled );
	}

	/** noindex posts never appear in the core sitemap. */
	public static function sitemap_exclude_noindex( $args ) {
		$args['meta_query'] = array_merge(
			isset( $args['meta_query'] ) && is_array( $args['meta_query'] ) ? $args['meta_query'] : array(),
			array(
				array(
					'relation' => 'OR',
					array( 'key' => self::F_NOINDEX, 'compare' => 'NOT EXISTS' ),
					array( 'key' => self::F_NOINDEX, 'value' => '1', 'compare' => '!=' ),
				),
			)
		);
		return $args;
	}

	/** Social image: per-post choice, then featured image, then the site default. */
	private static function social_image( $post ) {
		$id = $post ? (int) get_post_meta( $post->ID, self::F_OG_IMAGE, true ) : 0;
		if ( ! $id && $post ) {
			$id = (int) get_post_thumbnail_id( $post->ID );
		}
		if ( $id ) {
			$src = wp_get_attachment_image_src( $id, 'full' );
			if ( $src ) {
				return array( 'url' => $src[0], 'width' => (int) $src[1], 'height' => (int) $src[2], 'alt' => (string) get_post_meta( $id, '_wp_attachment_image_alt', true ) );
			}
		}
		$default = self::site_wide() ? (string) self::site()['og_default_image'] : '';
		return '' !== $default ? array( 'url' => $default, 'width' => 0, 'height' => 0, 'alt' => '' ) : null;
	}

	public static function head() {
		$post = self::current_post();
		if ( ! $post && ! self::site_wide() ) {
			return;
		}
		if ( is_404() ) {
			return;
		}
		$site  = self::site();
		$out   = array();
		$title = self::document_title( '' );
		if ( '' === $title ) {
			$title = wp_get_document_title();
		}
		$description = self::description();
		$canonical   = self::canonical();
		if ( '' !== $description ) {
			$out[] = '<meta name="description" content="' . esc_attr( $description ) . '" />';
		}
		if ( '' !== $canonical && ( ! $post || '' !== (string) get_post_meta( $post->ID, self::F_CANONICAL, true ) ) ) {
			$out[] = '<link rel="canonical" href="' . esc_url( $canonical ) . '" />';
		}
		if ( ! is_search() ) {
			$og_title = $post ? (string) get_post_meta( $post->ID, self::F_OG_TITLE, true ) : '';
			$og_desc  = $post ? (string) get_post_meta( $post->ID, self::F_OG_DESC, true ) : '';
			$image    = self::social_image( $post );
			$og       = array(
				'og:type'        => $post && 'post' === $post->post_type ? 'article' : 'website',
				'og:title'       => '' !== $og_title ? $og_title : $title,
				'og:description' => '' !== $og_desc ? $og_desc : $description,
				'og:url'         => $canonical,
				'og:site_name'   => get_bloginfo( 'name' ),
				'og:locale'      => str_replace( '-', '_', get_locale() ),
			);
			if ( $post && 'post' === $post->post_type ) {
				$og['article:published_time'] = get_post_time( 'c', true, $post );
				$og['article:modified_time']  = get_post_modified_time( 'c', true, $post );
			}
			if ( $image ) {
				$og['og:image'] = $image['url'];
				if ( $image['width'] ) {
					$og['og:image:width']  = (string) $image['width'];
					$og['og:image:height'] = (string) $image['height'];
				}
				if ( '' !== $image['alt'] ) {
					$og['og:image:alt'] = $image['alt'];
				}
			}
			$og = apply_filters( 'r72pub_opengraph', $og, $post );
			foreach ( $og as $property => $content ) {
				if ( '' !== (string) $content ) {
					$out[] = '<meta property="' . esc_attr( $property ) . '" content="' . esc_attr( $content ) . '" />';
				}
			}
			$tw = array(
				'twitter:card'        => $image ? $site['twitter_card'] : 'summary',
				'twitter:site'        => self::site_wide() ? $site['twitter_site'] : '',
				'twitter:title'       => $og['og:title'] ?? $title,
				'twitter:description' => $og['og:description'] ?? $description,
			);
			if ( $image ) {
				$tw['twitter:image'] = $image['url'];
				if ( '' !== $image['alt'] ) {
					$tw['twitter:image:alt'] = $image['alt'];
				}
			}
			foreach ( $tw as $name => $content ) {
				if ( '' !== (string) $content ) {
					$out[] = '<meta name="' . esc_attr( $name ) . '" content="' . esc_attr( $content ) . '" />';
				}
			}
		}
		foreach ( self::schema( $post, $title, $description, $canonical ) as $graph ) {
			$out[] = '<script type="application/ld+json">' . wp_json_encode( $graph, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP ) . '</script>';
		}
		if ( $out ) {
			echo implode( "\n", $out ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- every value escaped above.
		}
	}

	// ─── Structured data (factual only) ─────────────────────────────────────

	private static function publisher() {
		$site = self::site();
		$name = '' !== $site['organization_name'] ? $site['organization_name'] : get_bloginfo( 'name' );
		$type = 'person' === $site['kg_type'] ? 'Person' : 'Organization';
		$node = array( '@type' => $type, 'name' => $name, 'url' => home_url( '/' ) );
		if ( '' !== $site['logo_url'] ) {
			$node[ 'Person' === $type ? 'image' : 'logo' ] = array( '@type' => 'ImageObject', 'url' => $site['logo_url'] );
		}
		if ( $site['social_profiles'] ) {
			$node['sameAs'] = array_values( $site['social_profiles'] );
		}
		return $node;
	}

	/** @return array[] JSON-LD graphs to output */
	public static function schema( $post, $title, $description, $canonical ) {
		$site   = self::site();
		$graphs = array();
		if ( ( is_front_page() || ( is_home() && ! $post ) ) && self::site_wide() && '' !== $site['kg_type'] ) {
			$graphs[] = array( '@context' => 'https://schema.org' ) + self::publisher();
		}
		if ( $post && 'post' === $post->post_type && ( ( self::site_wide() && $site['article_schema'] ) || self::managed( $post ) ) ) {
			$intent = self::intent( $post->ID );
			$image  = self::social_image( $post );
			$schema = array(
				'@context'         => 'https://schema.org',
				'@type'            => 'Article',
				'headline'         => mb_substr( wp_strip_all_tags( get_the_title( $post ) ), 0, 110 ),
				'datePublished'    => get_post_time( 'c', true, $post ),
				'dateModified'     => get_post_modified_time( 'c', true, $post ),
				'mainEntityOfPage' => array( '@type' => 'WebPage', '@id' => $canonical ),
				'url'              => $canonical,
				'publisher'        => self::publisher(),
			);
			if ( '' !== $description ) {
				$schema['description'] = $description;
			}
			$author_name = $intent && '' !== $intent['author'] ? $intent['author'] : get_the_author_meta( 'display_name', (int) $post->post_author );
			if ( '' !== (string) $author_name ) {
				$schema['author'] = array( '@type' => 'Person', 'name' => $author_name );
			}
			if ( $image && $image['width'] ) {
				$schema['image'] = array( '@type' => 'ImageObject', 'url' => $image['url'], 'width' => $image['width'], 'height' => $image['height'] );
			} elseif ( $image ) {
				$schema['image'] = $image['url'];
			}
			$schema['inLanguage'] = $intent && '' !== $intent['locale'] ? $intent['locale'] : get_bloginfo( 'language' );
			if ( $intent && $intent['citations'] ) {
				$schema['citation'] = array_map(
					function ( $c ) {
						return array_filter( array( '@type' => 'CreativeWork', 'url' => $c['url'], 'name' => $c['title'] ) );
					},
					$intent['citations']
				);
			}
			$graphs[] = $schema;
		}
		return apply_filters( 'r72pub_schema', $graphs, $post );
	}
}
