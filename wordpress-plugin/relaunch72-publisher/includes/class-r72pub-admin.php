<?php
/**
 * Admin: top-level "Relaunch72" menu with Connection, SEO, Managed posts, Diagnostics and
 * Activity screens. Administrator-only (manage_options), every action nonce-protected,
 * every input sanitised and every output escaped. Changes to site-wide output are
 * previewed first and applied only for the rows the administrator ticks.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Admin {
	const SLUG = 'relaunch72-publisher';

	public static function tabs() {
		return array(
			'connection'  => __( 'Connection', 'relaunch72-publisher' ),
			'seo'         => __( 'SEO', 'relaunch72-publisher' ),
			'posts'       => __( 'Managed posts', 'relaunch72-publisher' ),
			'diagnostics' => __( 'Diagnostics', 'relaunch72-publisher' ),
			'activity'    => __( 'Activity', 'relaunch72-publisher' ),
		);
	}

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		foreach ( array( 'rotate', 'disconnect', 'pause', 'resume', 'save', 'public_check', 'seo_preview', 'seo_apply', 'allow', 'detach' ) as $action ) {
			add_action( 'admin_post_r72pub_' . $action, array( __CLASS__, 'handle_' . $action ) );
		}
		add_filter( 'plugin_action_links_' . plugin_basename( R72PUB_FILE ), array( __CLASS__, 'links' ) );
	}

	public static function links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url( 'seo' ) ) . '">' . esc_html__( 'SEO settings', 'relaunch72-publisher' ) . '</a>', '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Connection', 'relaunch72-publisher' ) . '</a>' );
		return $links;
	}

	private static function slug( $tab ) {
		return 'connection' === $tab ? self::SLUG : self::SLUG . '-' . $tab;
	}

	public static function menu() {
		add_menu_page( 'Relaunch72 Publisher & SEO', 'Relaunch72', 'manage_options', self::SLUG, array( __CLASS__, 'page' ), 'dashicons-admin-site-alt3', 81 );
		foreach ( self::tabs() as $tab => $label ) {
			add_submenu_page( self::SLUG, $label, $label, 'manage_options', self::slug( $tab ), array( __CLASS__, 'page' ) );
		}
	}

	public static function url( $tab = 'connection', array $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::slug( $tab ) ), $args ), admin_url( 'admin.php' ) );
	}

	private static function current_tab() {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : self::SLUG; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		foreach ( array_keys( self::tabs() ) as $tab ) {
			if ( self::slug( $tab ) === $page ) {
				return $tab;
			}
		}
		$tab = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'connection'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		return isset( self::tabs()[ $tab ] ) ? $tab : 'connection';
	}

	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to change Relaunch72 Publisher settings.', 'relaunch72-publisher' ), 403 );
		}
		check_admin_referer( 'r72pub_' . $action );
	}

	private static function done( $tab, $notice, array $args = array() ) {
		wp_safe_redirect( self::url( $tab, array_merge( array( 'r72notice' => $notice ), $args ) ) );
		exit;
	}

	private static function form_open( $action, $inline = true ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"' . ( $inline ? ' style="display:inline"' : '' ) . '>';
		echo '<input type="hidden" name="action" value="' . esc_attr( 'r72pub_' . $action ) . '" />';
		wp_nonce_field( 'r72pub_' . $action );
	}

	private static function text( $key, $default = '' ) {
		return isset( $_POST[ $key ] ) ? sanitize_text_field( wp_unslash( $_POST[ $key ] ) ) : $default; // phpcs:ignore WordPress.Security.NonceVerification.Missing -- callers run guard() first.
	}

	// ─── Connection actions ─────────────────────────────────────────────────

	public static function handle_rotate() {
		self::guard( 'rotate' );
		$secret = R72Pub_Settings::rotate_secret();
		set_transient( 'r72pub_reveal_' . get_current_user_id(), $secret, 600 ); // Shown once to this administrator, then deleted.
		self::done( 'connection', 'key' );
	}

	public static function handle_disconnect() {
		self::guard( 'disconnect' );
		R72Pub_Settings::disconnect();
		self::done( 'connection', 'disconnected' );
	}

	public static function handle_pause() {
		self::guard( 'pause' );
		R72Pub_Settings::update( array( 'paused' => true ) );
		R72Pub_Settings::audit( 'writes.paused', 'Incoming writes paused by ' . wp_get_current_user()->user_login . '.' );
		self::done( 'connection', 'paused' );
	}

	public static function handle_resume() {
		self::guard( 'resume' );
		R72Pub_Settings::update( array( 'paused' => false ) );
		R72Pub_Settings::audit( 'writes.resumed', 'Incoming writes resumed by ' . wp_get_current_user()->user_login . '.' );
		self::done( 'connection', 'resumed' );
	}

	public static function handle_save() {
		self::guard( 'save' );
		$author   = absint( self::text( 'author_id', '0' ) );
		$user     = $author ? get_user_by( 'id', $author ) : false;
		$prefixes = array();
		$raw      = isset( $_POST['media_prefixes'] ) ? sanitize_textarea_field( wp_unslash( $_POST['media_prefixes'] ) ) : '';
		foreach ( preg_split( '/\r\n|\r|\n/', $raw ) as $line ) {
			$line = trim( $line );
			if ( '' !== $line && R72Pub_Settings::valid_media_prefix( $line ) ) {
				$prefixes[] = esc_url_raw( $line );
			}
		}
		$mode = sanitize_key( self::text( 'seo_mode', 'auto' ) );
		R72Pub_Settings::update(
			array(
				'author_id'         => ( $user && user_can( $user, 'publish_posts' ) ) ? $author : 0,
				'media_prefixes'    => array_slice( array_unique( $prefixes ), 0, 10 ),
				'create_categories' => ! empty( $_POST['create_categories'] ),
				'max_categories'    => max( 0, min( 5, (int) self::text( 'max_categories', '3' ) ) ),
				'seo_mode'          => in_array( $mode, array( 'auto', 'content_only' ), true ) ? $mode : 'auto',
			)
		);
		R72Pub_Settings::audit( 'settings.saved', 'Publishing settings saved by ' . wp_get_current_user()->user_login . '.' );
		self::done( 'connection', 'saved' );
	}

	public static function handle_public_check() {
		self::guard( 'public_check' );
		set_transient( 'r72pub_public_check', self::public_check(), 3600 );
		self::done( 'diagnostics', 'checked' );
	}

	public static function handle_allow() {
		self::guard( 'allow' );
		$post_id = absint( self::text( 'post_id', '0' ) );
		if ( $post_id && get_post_meta( $post_id, R72Pub_Publisher::META_ARTICLE, true ) ) {
			update_post_meta( $post_id, R72Pub_Publisher::META_ALLOW, 1 );
			R72Pub_Settings::audit( 'post.release', 'Post ' . $post_id . ' released for the next Relaunch72 update (manual edits may be replaced).' );
		}
		self::done( 'posts', 'allowed' );
	}

	public static function handle_detach() {
		self::guard( 'detach' );
		$post_id = absint( self::text( 'post_id', '0' ) );
		if ( $post_id && get_post_meta( $post_id, R72Pub_Publisher::META_ARTICLE, true ) ) {
			update_post_meta( $post_id, R72Pub_Publisher::META_DETACHED, 1 );
			R72Pub_Settings::audit( 'post.detached', 'Post ' . $post_id . ' detached; Relaunch72 will not update it.' );
		}
		self::done( 'posts', 'detached' );
	}

	// ─── SEO settings: preview, then apply only ticked rows ─────────────────

	/** Human-readable effect of each SEO setting, for the preview table. */
	public static function seo_effects() {
		return array(
			'blogname'          => __( 'WordPress site title, used everywhere WordPress and the theme show it and as %sitename% in templates.', 'relaunch72-publisher' ),
			'blogdescription'   => __( 'WordPress tagline, shown by many themes and used as %tagline%.', 'relaunch72-publisher' ),
			'site_wide'         => __( 'Master switch. Off: this plugin only touches Relaunch72-managed posts. On: every title, description, robots, social, schema and sitemap setting below applies to the whole site.', 'relaunch72-publisher' ),
			'separator'         => __( 'Character between title parts (%sep%).', 'relaunch72-publisher' ),
			'title_home'        => __( 'Browser/search title of the home page and the posts page.', 'relaunch72-publisher' ),
			'title_post'        => __( 'Title of every post without its own SEO title.', 'relaunch72-publisher' ),
			'title_page'        => __( 'Title of every page without its own SEO title.', 'relaunch72-publisher' ),
			'title_archive'     => __( 'Title of category, tag, author, date and post-type archives.', 'relaunch72-publisher' ),
			'title_search'      => __( 'Title of search result pages (blank keeps the theme/WordPress title).', 'relaunch72-publisher' ),
			'title_404'         => __( 'Title of the not-found page (blank keeps the theme/WordPress title).', 'relaunch72-publisher' ),
			'desc_home'         => __( 'Meta description of the home page and posts page.', 'relaunch72-publisher' ),
			'desc_archive'      => __( 'Meta description of category, tag and term archives.', 'relaunch72-publisher' ),
			'noindex_category'  => __( 'Adds noindex,follow to category archives.', 'relaunch72-publisher' ),
			'noindex_tag'       => __( 'Adds noindex,follow to tag archives.', 'relaunch72-publisher' ),
			'noindex_author'    => __( 'Adds noindex,follow to author archives.', 'relaunch72-publisher' ),
			'noindex_date'      => __( 'Adds noindex,follow to date archives.', 'relaunch72-publisher' ),
			'noindex_search'    => __( 'Adds noindex,follow to search result pages.', 'relaunch72-publisher' ),
			'noindex_paged'     => __( 'Adds noindex,follow to page 2+ of any archive.', 'relaunch72-publisher' ),
			'kg_type'           => __( 'Outputs Organization or Person schema on the home page (blank: none).', 'relaunch72-publisher' ),
			'organization_name' => __( 'Publisher/organisation name in Article and home-page schema.', 'relaunch72-publisher' ),
			'logo_url'          => __( 'Logo (or person image) URL in schema.', 'relaunch72-publisher' ),
			'social_profiles'   => __( 'sameAs profile links in home-page schema.', 'relaunch72-publisher' ),
			'og_default_image'  => __( 'Social preview image for content without a featured or social image.', 'relaunch72-publisher' ),
			'twitter_card'      => __( 'Twitter/X card type when an image is available.', 'relaunch72-publisher' ),
			'twitter_site'      => __( 'twitter:site handle on every page.', 'relaunch72-publisher' ),
			'article_schema'    => __( 'Outputs factual Article schema on every post (managed posts always get it).', 'relaunch72-publisher' ),
			'core_sitemap'      => __( 'WordPress core XML sitemap: default (WordPress decides), force on, or off. noindex posts are always excluded.', 'relaunch72-publisher' ),
		);
	}

	public static function handle_seo_preview() {
		self::guard( 'seo_preview' );
		$raw = isset( $_POST['seo'] ) && is_array( $_POST['seo'] ) ? wp_unslash( $_POST['seo'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- sanitised next.
		foreach ( R72Pub_Settings::site_seo_fields() as $key => $type ) {
			if ( 'bool' === $type ) {
				$raw[ $key ] = ! empty( $raw[ $key ] );
			}
		}
		$proposal = R72Pub_Settings::sanitize_site_seo( $raw );
		$proposal = array( 'blogname' => self::text( 'blogname', get_option( 'blogname' ) ), 'blogdescription' => self::text( 'blogdescription', get_option( 'blogdescription' ) ) ) + $proposal;
		set_transient( 'r72pub_seo_proposal_' . get_current_user_id(), $proposal, 1800 );
		self::done( 'seo', 'preview' );
	}

	public static function handle_seo_apply() {
		self::guard( 'seo_apply' );
		$key      = 'r72pub_seo_proposal_' . get_current_user_id();
		$proposal = get_transient( $key );
		$chosen   = isset( $_POST['apply'] ) && is_array( $_POST['apply'] ) ? array_map( 'sanitize_key', wp_unslash( $_POST['apply'] ) ) : array();
		if ( ! is_array( $proposal ) || ! $chosen ) {
			self::done( 'seo', 'nothing' );
		}
		$site    = R72Pub_Settings::site_seo();
		$fields  = R72Pub_Settings::site_seo_fields();
		$applied = array();
		foreach ( $chosen as $field ) {
			if ( ! array_key_exists( $field, $proposal ) ) {
				continue;
			}
			if ( in_array( $field, array( 'blogname', 'blogdescription' ), true ) ) {
				update_option( $field, $proposal[ $field ] );
			} elseif ( isset( $fields[ $field ] ) ) {
				$site[ $field ] = $proposal[ $field ];
			} else {
				continue;
			}
			$applied[] = $field;
		}
		update_option( R72Pub_Settings::OPT_SITE_SEO, R72Pub_Settings::sanitize_site_seo( $site ), false );
		delete_transient( $key );
		R72Pub_Settings::audit( 'seo.applied', 'SEO settings changed by ' . wp_get_current_user()->user_login . ': ' . implode( ', ', $applied ) . '.' );
		self::done( 'seo', 'applied' );
	}

	// ─── Public output check ────────────────────────────────────────────────

	/** Fetch public pages as a visitor would and report what the server actually serves. */
	public static function public_check() {
		$managed = get_posts( array( 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids', 'meta_key' => R72Pub_Publisher::META_ARTICLE ) );
		$any     = $managed ? $managed : get_posts( array( 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids' ) );
		$urls    = array( 'home' => home_url( '/' ) );
		if ( $any ) {
			$urls['post'] = get_permalink( $any[0] );
		}
		$cats = get_categories( array( 'number' => 1, 'hide_empty' => true ) );
		if ( $cats ) {
			$urls['category'] = get_category_link( $cats[0]->term_id );
		}
		$sitemap = R72Pub_Seo::sitemap();
		$out     = array( 'at' => gmdate( 'c' ), 'pages' => array(), 'sitemap' => null, 'managed' => (bool) $managed );
		foreach ( $urls as $kind => $url ) {
			$r = wp_remote_get( $url, array( 'timeout' => 15, 'redirection' => 3, 'user-agent' => 'Relaunch72-Publisher-Check/' . R72PUB_VERSION ) );
			if ( is_wp_error( $r ) ) {
				$out['pages'][ $kind ] = array( 'url' => $url, 'error' => __( 'Could not be fetched from the server itself (loopback). Check from outside, or with Relaunch72\'s public verification.', 'relaunch72-publisher' ) );
				continue;
			}
			$html = (string) wp_remote_retrieve_body( $r );
			preg_match( '#<head\b[^>]*>(.*?)</head>#is', $html, $m );
			$head  = isset( $m[1] ) ? preg_replace( '#<!--.*?-->#s', '', $m[1] ) : '';
			$count = function ( $pattern ) use ( $head ) {
				return preg_match_all( $pattern, $head );
			};
			$out['pages'][ $kind ] = array(
				'url'         => $url,
				'http'        => (int) wp_remote_retrieve_response_code( $r ),
				'canonical'   => $count( '#<link\b[^>]*rel=["\']?canonical#i' ),
				'description' => $count( '#<meta\b[^>]*name=["\']description["\']#i' ),
				'robots'      => $count( '#<meta\b[^>]*name=["\']robots["\']#i' ),
				'ogTitle'     => $count( '#<meta\b[^>]*property=["\']og:title["\']#i' ),
				'jsonLd'      => $count( '#<script\b[^>]*application/ld\+json#i' ),
				'r72Marker'   => $count( '#<meta\b[^>]*name=["\']r72-blog-version["\']#i' ),
				'cache'       => array_filter(
					array(
						'cache-control'     => wp_remote_retrieve_header( $r, 'cache-control' ),
						'age'               => wp_remote_retrieve_header( $r, 'age' ),
						'x-cache'           => wp_remote_retrieve_header( $r, 'x-cache' ),
						'cf-cache-status'   => wp_remote_retrieve_header( $r, 'cf-cache-status' ),
						'x-proxy-cache'     => wp_remote_retrieve_header( $r, 'x-proxy-cache' ),
						'x-litespeed-cache' => wp_remote_retrieve_header( $r, 'x-litespeed-cache' ),
					)
				),
			);
		}
		if ( '' !== $sitemap['url'] ) {
			$r              = wp_remote_get( $sitemap['url'], array( 'timeout' => 15, 'redirection' => 0 ) );
			$out['sitemap'] = array( 'url' => $sitemap['url'], 'owner' => $sitemap['owner'], 'http' => is_wp_error( $r ) ? 0 : (int) wp_remote_retrieve_response_code( $r ) );
		}
		return $out;
	}

	// ─── Pages ──────────────────────────────────────────────────────────────

	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$tab = self::current_tab();
		echo '<div class="wrap"><h1>Relaunch72 Publisher &amp; SEO</h1>';
		self::notice();
		echo '<nav class="nav-tab-wrapper">';
		foreach ( self::tabs() as $key => $label ) {
			echo '<a class="nav-tab' . ( $key === $tab ? ' nav-tab-active' : '' ) . '" href="' . esc_url( self::url( $key ) ) . '">' . esc_html( $label ) . '</a>';
		}
		echo '</nav>';
		$method = 'tab_' . $tab;
		self::$method();
		echo '</div>';
	}

	private static function notice() {
		$n        = isset( $_GET['r72notice'] ) ? sanitize_key( wp_unslash( $_GET['r72notice'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
		$messages = array(
			'key'          => __( 'A new connection key was created. Any previous key no longer works.', 'relaunch72-publisher' ),
			'disconnected' => __( 'Disconnected. The key and brand pairing were removed; published posts were kept.', 'relaunch72-publisher' ),
			'paused'       => __( 'Incoming writes are paused. Relaunch72 can still check status and reconcile.', 'relaunch72-publisher' ),
			'resumed'      => __( 'Incoming writes resumed.', 'relaunch72-publisher' ),
			'saved'        => __( 'Settings saved.', 'relaunch72-publisher' ),
			'checked'      => __( 'Public output check finished.', 'relaunch72-publisher' ),
			'allowed'      => __( 'The next Relaunch72 update may replace manual edits on that post.', 'relaunch72-publisher' ),
			'detached'     => __( 'Post detached. Relaunch72 will not update it again.', 'relaunch72-publisher' ),
			'preview'      => __( 'Review the proposed changes below. Nothing has changed yet.', 'relaunch72-publisher' ),
			'applied'      => __( 'The selected SEO settings were applied.', 'relaunch72-publisher' ),
			'nothing'      => __( 'No changes were selected, so nothing changed.', 'relaunch72-publisher' ),
		);
		if ( isset( $messages[ $n ] ) ) {
			echo '<div class="notice notice-info is-dismissible"><p>' . esc_html( $messages[ $n ] ) . '</p></div>';
		}
	}

	private static function versions_row() {
		$wp_ok  = version_compare( get_bloginfo( 'version' ), R72PUB_MIN_WP, '>=' );
		$php_ok = version_compare( PHP_VERSION, R72PUB_MIN_PHP, '>=' );
		echo '<p>' . esc_html(
			/* translators: 1: plugin version, 2: WordPress version, 3: PHP version, 4: minimum WordPress, 5: minimum PHP */
			sprintf( __( 'Plugin %1$s · WordPress %2$s · PHP %3$s. Supported: WordPress %4$s or newer, PHP %5$s or newer.', 'relaunch72-publisher' ), R72PUB_VERSION, get_bloginfo( 'version' ) . ( $wp_ok ? '' : ' (' . __( 'unsupported', 'relaunch72-publisher' ) . ')' ), PHP_VERSION . ( $php_ok ? '' : ' (' . __( 'unsupported', 'relaunch72-publisher' ) . ')' ), R72PUB_MIN_WP, R72PUB_MIN_PHP )
		) . '</p>';
	}

	private static function tab_connection() {
		$settings = R72Pub_Settings::get();
		$pairing  = R72Pub_Settings::pairing();
		$reveal   = get_transient( 'r72pub_reveal_' . get_current_user_id() );
		self::versions_row();
		echo '<h2>' . esc_html__( '1. Connection key', 'relaunch72-publisher' ) . '</h2>';
		if ( is_string( $reveal ) && '' !== $reveal ) {
			delete_transient( 'r72pub_reveal_' . get_current_user_id() );
			echo '<div class="notice notice-warning inline"><p><strong>' . esc_html__( 'Copy this key now; it will not be shown again.', 'relaunch72-publisher' ) . '</strong> ' . esc_html__( 'Enter it only in Relaunch72\'s secure website connection form (never in email or chat).', 'relaunch72-publisher' ) . '</p><p><input type="text" readonly class="large-text code" value="' . esc_attr( $reveal ) . '" onclick="this.select()" /></p></div>';
		}
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row">' . esc_html__( 'Status', 'relaunch72-publisher' ) . '</th><td>' . ( R72Pub_Settings::has_secret() ? esc_html__( 'Key created', 'relaunch72-publisher' ) : esc_html__( 'No key yet', 'relaunch72-publisher' ) ) . ( empty( $pairing['brandId'] ) ? ' · ' . esc_html__( 'not yet paired with a Relaunch72 brand', 'relaunch72-publisher' ) : ' · ' . esc_html__( 'paired with Relaunch72 brand', 'relaunch72-publisher' ) . ' <code>' . esc_html( $pairing['brandId'] ) . '</code>, ' . esc_html__( 'connection', 'relaunch72-publisher' ) . ' <code>' . esc_html( $pairing['destinationId'] ) . '</code>, ' . esc_html__( 'last check', 'relaunch72-publisher' ) . ' ' . esc_html( $pairing['lastCheckAt'] ?? '' ) ) . '</td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Site address for Relaunch72', 'relaunch72-publisher' ) . '</th><td><code>' . esc_html( R72Pub_Capabilities::origin() ) . '</code></td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Publishing endpoint', 'relaunch72-publisher' ) . '</th><td><code>' . esc_html( R72Pub_Rest::endpoint() ) . '</code></td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Site ID', 'relaunch72-publisher' ) . '</th><td><code>' . esc_html( R72Pub_Settings::site_id() ) . '</code></td></tr>';
		echo '</tbody></table><p>';
		self::form_open( 'rotate' );
		submit_button( R72Pub_Settings::has_secret() ? __( 'Rotate key (revokes the current key and pairing)', 'relaunch72-publisher' ) : __( 'Create connection key', 'relaunch72-publisher' ), 'primary', 'submit', false );
		echo '</form> ';
		if ( R72Pub_Settings::has_secret() ) {
			self::form_open( 'disconnect' );
			submit_button( __( 'Disconnect (keeps all posts)', 'relaunch72-publisher' ), 'secondary', 'submit', false, array( 'onclick' => "return confirm('" . esc_js( __( 'Disconnect Relaunch72? Published posts stay.', 'relaunch72-publisher' ) ) . "');" ) );
			echo '</form>';
		}
		echo '</p><h2>' . esc_html__( '2. Stop switch', 'relaunch72-publisher' ) . '</h2><p>' . ( $settings['paused'] ? '<strong>' . esc_html__( 'Incoming writes are paused.', 'relaunch72-publisher' ) . '</strong> ' : esc_html__( 'Incoming writes are allowed.', 'relaunch72-publisher' ) . ' ' ) . esc_html__( 'Pausing refuses every new delivery; status checks and reconciliation keep working.', 'relaunch72-publisher' ) . '</p><p>';
		self::form_open( $settings['paused'] ? 'resume' : 'pause' );
		submit_button( $settings['paused'] ? __( 'Resume incoming writes', 'relaunch72-publisher' ) : __( 'Pause incoming writes', 'relaunch72-publisher' ), $settings['paused'] ? 'primary' : 'delete', 'submit', false );
		echo '</form></p>';

		echo '<h2>' . esc_html__( '3. Publishing settings', 'relaunch72-publisher' ) . '</h2>';
		self::form_open( 'save', false );
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row"><label for="r72-author">' . esc_html__( 'Publish as', 'relaunch72-publisher' ) . '</label></th><td><select id="r72-author" name="author_id"><option value="0">' . esc_html__( '— Choose a user —', 'relaunch72-publisher' ) . '</option>';
		foreach ( get_users( array( 'capability' => array( 'publish_posts', 'upload_files' ), 'fields' => array( 'ID', 'display_name', 'user_login' ), 'number' => 200 ) ) as $u ) {
			echo '<option value="' . esc_attr( $u->ID ) . '"' . selected( $settings['author_id'], (int) $u->ID, false ) . '>' . esc_html( $u->display_name . ' (' . $u->user_login . ')' ) . '</option>';
		}
		echo '</select><p class="description">' . esc_html__( 'A dedicated Author or Editor account is recommended. Posts appear under this user.', 'relaunch72-publisher' ) . '</p></td></tr>';
		echo '<tr><th scope="row"><label for="r72-media">' . esc_html__( 'Approved image sources', 'relaunch72-publisher' ) . '</label></th><td><textarea id="r72-media" name="media_prefixes" rows="3" class="large-text code">' . esc_textarea( implode( "\n", $settings['media_prefixes'] ) ) . '</textarea><p class="description">' . esc_html__( 'One https prefix per line, ending in "/". Images from anywhere else are refused. Redirects are never followed.', 'relaunch72-publisher' ) . '</p></td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Categories', 'relaunch72-publisher' ) . '</th><td><label><input type="checkbox" name="create_categories" value="1"' . checked( $settings['create_categories'], true, false ) . ' /> ' . esc_html__( 'Create a missing top-level category named in the owner-approved Relaunch72 structure', 'relaunch72-publisher' ) . '</label><br /><label>' . esc_html__( 'Maximum per article', 'relaunch72-publisher' ) . ' <input type="number" min="0" max="5" name="max_categories" value="' . esc_attr( $settings['max_categories'] ) . '" class="small-text" /></label></td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'SEO mode', 'relaunch72-publisher' ) . '</th><td><label><input type="radio" name="seo_mode" value="auto"' . checked( $settings['seo_mode'], 'auto', false ) . ' /> ' . esc_html__( 'Automatic (Yoast SEO, Rank Math, or this plugin\'s standalone SEO when neither is active)', 'relaunch72-publisher' ) . '</label><br /><label><input type="radio" name="seo_mode" value="content_only"' . checked( $settings['seo_mode'], 'content_only', false ) . ' /> ' . esc_html__( 'Content only: write no SEO values and output no SEO tags', 'relaunch72-publisher' ) . '</label></td></tr>';
		echo '</tbody></table>';
		submit_button( __( 'Save settings', 'relaunch72-publisher' ) );
		echo '</form>';
		echo '<h2>' . esc_html__( 'Setup steps', 'relaunch72-publisher' ) . '</h2><ol><li>' . esc_html__( 'Choose the "Publish as" user and save.', 'relaunch72-publisher' ) . '</li><li>' . esc_html__( 'Create a connection key and copy it.', 'relaunch72-publisher' ) . '</li><li>' . esc_html__( 'In Relaunch72: Website connections → WordPress → enter this site address and paste the key into the secure key field → Check connection.', 'relaunch72-publisher' ) . '</li><li>' . esc_html__( 'Review the Diagnostics tab here; resolve any hold shown.', 'relaunch72-publisher' ) . '</li><li>' . esc_html__( 'Relaunch72 publishes only owner-approved article versions; the connection check publishes nothing.', 'relaunch72-publisher' ) . '</li></ol>';
	}

	private static function tab_seo() {
		$seo      = R72Pub_Seo::status();
		$site     = R72Pub_Settings::site_seo();
		$proposal = get_transient( 'r72pub_seo_proposal_' . get_current_user_id() );
		$current  = array( 'blogname' => get_option( 'blogname' ), 'blogdescription' => get_option( 'blogdescription' ) ) + $site;
		$provider = in_array( $seo['mode'], array( 'yoast', 'rank_math' ), true );
		echo '<p>' . esc_html( $seo['message'] ) . '</p>';
		if ( $provider || 'content_only' === $seo['mode'] ) {
			echo '<div class="notice notice-info inline"><p>' . esc_html(
				/* translators: %s: SEO provider name */
				sprintf( __( 'Site-wide titles, descriptions, robots, social previews, schema and the sitemap are owned by %s. Change them in that plugin\'s settings; this plugin does not edit another plugin\'s configuration. Only the WordPress site title and tagline below apply here.', 'relaunch72-publisher' ), $seo['provider'] )
			) . '</p></div>';
		}
		if ( 'hold' === $seo['mode'] ) {
			echo '<div class="notice notice-error inline"><p>' . esc_html( $seo['message'] ) . '</p></div>';
		}
		if ( is_array( $proposal ) ) {
			self::seo_preview_table( $proposal, $current );
		}
		echo '<h2>' . esc_html__( 'Propose SEO settings', 'relaunch72-publisher' ) . '</h2><p>' . esc_html__( 'Proposals are previewed first with their effect and sample output. Nothing changes until you tick and apply each row.', 'relaunch72-publisher' ) . '</p>';
		self::form_open( 'seo_preview', false );
		echo '<table class="form-table" role="presentation"><tbody>';
		self::row_text( 'blogname', __( 'Site title', 'relaunch72-publisher' ), $current['blogname'], '', 'blogname' );
		self::row_text( 'blogdescription', __( 'Tagline', 'relaunch72-publisher' ), $current['blogdescription'], '', 'blogdescription' );
		if ( 'standalone' === $seo['mode'] ) {
			echo '</tbody></table><h3>' . esc_html__( 'Site-wide output', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			self::row_bool( 'site_wide', __( 'Apply this plugin\'s SEO output to the whole site', 'relaunch72-publisher' ), $site['site_wide'], __( 'Off: only Relaunch72-managed posts carry this plugin\'s tags. On: the settings below apply to every post, page and archive.', 'relaunch72-publisher' ) );
			echo '</tbody></table><h3>' . esc_html__( 'Titles', 'relaunch72-publisher' ) . '</h3><p class="description">' . esc_html__( 'Variables:', 'relaunch72-publisher' ) . ' ';
			foreach ( R72Pub_Seo::template_variables() as $var => $help ) {
				echo '<code title="' . esc_attr( $help ) . '">' . esc_html( $var ) . '</code> ';
			}
			echo '</p><table class="form-table" role="presentation"><tbody>';
			self::row_text( 'separator', __( 'Title separator', 'relaunch72-publisher' ), $site['separator'], '', 'seo[separator]', 'small-text' );
			foreach ( array( 'title_home' => __( 'Home page', 'relaunch72-publisher' ), 'title_post' => __( 'Posts', 'relaunch72-publisher' ), 'title_page' => __( 'Pages', 'relaunch72-publisher' ), 'title_archive' => __( 'Archives', 'relaunch72-publisher' ), 'title_search' => __( 'Search results', 'relaunch72-publisher' ), 'title_404' => __( 'Not found page', 'relaunch72-publisher' ) ) as $key => $label ) {
				self::row_text( $key, $label, $site[ $key ], '', 'seo[' . $key . ']' );
			}
			echo '</tbody></table><h3>' . esc_html__( 'Descriptions', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			self::row_text( 'desc_home', __( 'Home page description', 'relaunch72-publisher' ), $site['desc_home'], '', 'seo[desc_home]' );
			self::row_text( 'desc_archive', __( 'Term archive description', 'relaunch72-publisher' ), $site['desc_archive'], __( 'Posts and pages use their own SEO box value.', 'relaunch72-publisher' ), 'seo[desc_archive]' );
			echo '</tbody></table><h3>' . esc_html__( 'Search engine directives', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			foreach ( array( 'noindex_category' => __( 'Category archives', 'relaunch72-publisher' ), 'noindex_tag' => __( 'Tag archives', 'relaunch72-publisher' ), 'noindex_author' => __( 'Author archives', 'relaunch72-publisher' ), 'noindex_date' => __( 'Date archives', 'relaunch72-publisher' ), 'noindex_search' => __( 'Search results', 'relaunch72-publisher' ), 'noindex_paged' => __( 'Page 2+ of archives', 'relaunch72-publisher' ) ) as $key => $label ) {
				self::row_bool( $key, $label, $site[ $key ], __( 'noindex, follow', 'relaunch72-publisher' ) );
			}
			echo '</tbody></table><h3>' . esc_html__( 'Social previews', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			self::row_text( 'og_default_image', __( 'Default social image URL', 'relaunch72-publisher' ), $site['og_default_image'], '', 'seo[og_default_image]' );
			echo '<tr><th scope="row">' . esc_html__( 'Twitter/X card', 'relaunch72-publisher' ) . '</th><td><select name="seo[twitter_card]"><option value="summary_large_image"' . selected( $site['twitter_card'], 'summary_large_image', false ) . '>summary_large_image</option><option value="summary"' . selected( $site['twitter_card'], 'summary', false ) . '>summary</option></select></td></tr>';
			self::row_text( 'twitter_site', __( 'Twitter/X site handle', 'relaunch72-publisher' ), $site['twitter_site'], '@handle', 'seo[twitter_site]', 'regular-text' );
			echo '</tbody></table><h3>' . esc_html__( 'Knowledge graph and schema', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			echo '<tr><th scope="row">' . esc_html__( 'Site represents', 'relaunch72-publisher' ) . '</th><td><select name="seo[kg_type]"><option value=""' . selected( $site['kg_type'], '', false ) . '>' . esc_html__( '— No home-page schema —', 'relaunch72-publisher' ) . '</option><option value="organization"' . selected( $site['kg_type'], 'organization', false ) . '>' . esc_html__( 'Organisation', 'relaunch72-publisher' ) . '</option><option value="person"' . selected( $site['kg_type'], 'person', false ) . '>' . esc_html__( 'Person', 'relaunch72-publisher' ) . '</option></select></td></tr>';
			self::row_text( 'organization_name', __( 'Organisation / person name', 'relaunch72-publisher' ), $site['organization_name'], __( 'Blank uses the site title.', 'relaunch72-publisher' ), 'seo[organization_name]' );
			self::row_text( 'logo_url', __( 'Logo or image URL', 'relaunch72-publisher' ), $site['logo_url'], '', 'seo[logo_url]' );
			echo '<tr><th scope="row"><label for="r72-social">' . esc_html__( 'Social profile links', 'relaunch72-publisher' ) . '</label></th><td><textarea id="r72-social" name="seo[social_profiles]" rows="4" class="large-text code">' . esc_textarea( implode( "\n", (array) $site['social_profiles'] ) ) . '</textarea><p class="description">' . esc_html__( 'One URL per line.', 'relaunch72-publisher' ) . '</p></td></tr>';
			self::row_bool( 'article_schema', __( 'Article schema on every post', 'relaunch72-publisher' ), $site['article_schema'], __( 'Factual fields only: headline, dates, author, publisher, image, language.', 'relaunch72-publisher' ) );
			echo '</tbody></table><h3>' . esc_html__( 'Sitemap', 'relaunch72-publisher' ) . '</h3><table class="form-table" role="presentation"><tbody>';
			echo '<tr><th scope="row">' . esc_html__( 'WordPress core XML sitemap', 'relaunch72-publisher' ) . '</th><td><select name="seo[core_sitemap]"><option value="default"' . selected( $site['core_sitemap'], 'default', false ) . '>' . esc_html__( 'WordPress default', 'relaunch72-publisher' ) . '</option><option value="on"' . selected( $site['core_sitemap'], 'on', false ) . '>' . esc_html__( 'Force on', 'relaunch72-publisher' ) . '</option><option value="off"' . selected( $site['core_sitemap'], 'off', false ) . '>' . esc_html__( 'Off', 'relaunch72-publisher' ) . '</option></select><p class="description">' . esc_html__( 'noindex posts are always excluded from the core sitemap. Currently served:', 'relaunch72-publisher' ) . ' <code>' . esc_html( R72Pub_Seo::sitemap()['url'] ? R72Pub_Seo::sitemap()['url'] : __( 'none', 'relaunch72-publisher' ) ) . '</code></p></td></tr>';
		}
		echo '</tbody></table>';
		submit_button( __( 'Preview changes', 'relaunch72-publisher' ), 'primary' );
		echo '</form>';
	}

	private static function row_text( $id, $label, $value, $help, $name, $class = 'large-text' ) {
		echo '<tr><th scope="row"><label for="r72-' . esc_attr( $id ) . '">' . esc_html( $label ) . '</label></th><td><input type="text" class="' . esc_attr( $class ) . '" id="r72-' . esc_attr( $id ) . '" name="' . esc_attr( $name ) . '" value="' . esc_attr( (string) $value ) . '" />' . ( $help ? '<p class="description">' . esc_html( $help ) . '</p>' : '' ) . '</td></tr>';
	}

	private static function row_bool( $key, $label, $value, $help ) {
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td><label><input type="checkbox" name="seo[' . esc_attr( $key ) . ']" value="1"' . checked( ! empty( $value ), true, false ) . ' /> ' . esc_html( $help ) . '</label></td></tr>';
	}

	/** Changed rows only, each with current value, proposed value, effect and a sample. */
	private static function seo_preview_table( array $proposal, array $current ) {
		$effects = self::seo_effects();
		$display = function ( $v ) {
			return is_bool( $v ) ? ( $v ? __( 'On', 'relaunch72-publisher' ) : __( 'Off', 'relaunch72-publisher' ) ) : ( is_array( $v ) ? implode( "\n", $v ) : (string) $v );
		};
		$sample_post = get_posts( array( 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1 ) );
		$sample_page = get_posts( array( 'post_type' => 'page', 'post_status' => 'publish', 'posts_per_page' => 1 ) );
		$sample_cat  = get_categories( array( 'number' => 1, 'hide_empty' => false ) );
		$vars        = array(
			'title_home'    => array( '%title%' => '', '%page%' => '' ),
			'title_post'    => array( '%title%' => $sample_post ? get_the_title( $sample_post[0] ) : __( 'Example post', 'relaunch72-publisher' ), '%page%' => '', '%excerpt%' => '' ),
			'title_page'    => array( '%title%' => $sample_page ? get_the_title( $sample_page[0] ) : __( 'Example page', 'relaunch72-publisher' ), '%page%' => '' ),
			'title_archive' => array( '%title%' => $sample_cat ? $sample_cat[0]->name : __( 'Example category', 'relaunch72-publisher' ), '%term%' => $sample_cat ? $sample_cat[0]->name : '', '%page%' => __( 'Page 2', 'relaunch72-publisher' ) ),
			'title_search'  => array( '%title%' => 'example', '%search%' => 'example', '%page%' => '' ),
			'title_404'     => array( '%title%' => '', '%page%' => '' ),
			'desc_home'     => array( '%title%' => '' ),
			'desc_archive'  => array( '%term%' => $sample_cat ? $sample_cat[0]->name : '', '%term_description%' => $sample_cat ? wp_strip_all_tags( term_description( $sample_cat[0] ) ) : '' ),
		);
		$proposed_site = R72Pub_Settings::sanitize_site_seo( array_merge( R72Pub_Settings::site_seo(), array_diff_key( $proposal, array( 'blogname' => 1, 'blogdescription' => 1 ) ) ) );
		echo '<h2>' . esc_html__( 'Preview — tick each change to apply', 'relaunch72-publisher' ) . '</h2>';
		self::form_open( 'seo_apply', false );
		echo '<table class="widefat striped" style="max-width:1100px"><thead><tr><th>' . esc_html__( 'Apply', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Setting', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Current', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Proposed', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Effect', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Sample output', 'relaunch72-publisher' ) . '</th></tr></thead><tbody>';
		$changes = 0;
		foreach ( $proposal as $field => $value ) {
			$cur = $current[ $field ] ?? '';
			if ( wp_json_encode( $cur ) === wp_json_encode( $value ) ) {
				continue;
			}
			$changes++;
			$sample = isset( $vars[ $field ] ) && is_string( $value ) ? R72Pub_Seo::render_template( $value, array_merge( array( '%excerpt%' => '', '%search%' => '', '%term%' => '', '%term_description%' => '' ), $vars[ $field ] ), $proposed_site ) : '';
			echo '<tr><td><input type="checkbox" name="apply[]" value="' . esc_attr( $field ) . '" /></td><td>' . esc_html( $field ) . '</td><td><pre style="white-space:pre-wrap;margin:0">' . esc_html( $display( $cur ) ) . '</pre></td><td><pre style="white-space:pre-wrap;margin:0">' . esc_html( $display( $value ) ) . '</pre></td><td>' . esc_html( $effects[ $field ] ?? '' ) . '</td><td>' . esc_html( $sample ) . '</td></tr>';
		}
		if ( ! $changes ) {
			echo '<tr><td colspan="6">' . esc_html__( 'The proposal matches the current settings. Nothing to apply.', 'relaunch72-publisher' ) . '</td></tr>';
		}
		echo '</tbody></table>';
		if ( ! empty( $proposal['site_wide'] ) && empty( $current['site_wide'] ) ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html__( 'Turning site-wide output on changes the public <head> of every page: titles, descriptions, robots, social tags and schema will come from this plugin. Check the Diagnostics tab after applying.', 'relaunch72-publisher' ) . '</p></div>';
		}
		if ( $changes ) {
			submit_button( __( 'Apply selected changes', 'relaunch72-publisher' ) );
		}
		echo '</form>';
	}

	private static function tab_diagnostics() {
		$eval = R72Pub_Capabilities::evaluate();
		$caps = R72Pub_Capabilities::capabilities();
		echo '<h2>' . esc_html__( 'Readiness', 'relaunch72-publisher' ) . '</h2>';
		if ( ! $eval['blocking'] ) {
			echo '<p><strong>' . esc_html__( 'Ready.', 'relaunch72-publisher' ) . '</strong> ' . esc_html__( 'This site can accept Relaunch72 articles.', 'relaunch72-publisher' ) . '</p>';
		}
		foreach ( $eval['blocking'] as $issue ) {
			echo '<div class="notice notice-error inline"><p><strong>' . esc_html__( 'Hold:', 'relaunch72-publisher' ) . '</strong> ' . esc_html( $issue['message'] ) . '</p></div>';
		}
		foreach ( $eval['warnings'] as $issue ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html( $issue['message'] ) . '</p></div>';
		}
		$permalink = R72Pub_Capabilities::permalink();
		$rows      = array(
			__( 'Permalink structure', 'relaunch72-publisher' )  => $permalink['structure'] ? $permalink['structure'] : __( 'Plain', 'relaunch72-publisher' ),
			__( 'Posts index', 'relaunch72-publisher' )          => R72Pub_Capabilities::index()['url'],
			__( 'Article URL pattern', 'relaunch72-publisher' )  => $permalink['supported'] ? R72Pub_Capabilities::article_pattern() : '—',
			__( 'Category URL pattern', 'relaunch72-publisher' ) => R72Pub_Capabilities::category_pattern(),
			__( 'SEO owner', 'relaunch72-publisher' )            => $eval['seo']['provider'] . ' (' . $eval['seo']['mode'] . ')',
			__( 'SEO detail', 'relaunch72-publisher' )           => $eval['seo']['message'],
			__( 'Site-wide output', 'relaunch72-publisher' )     => 'standalone' === $eval['seo']['mode'] ? ( R72Pub_Seo::site_wide() ? __( 'On', 'relaunch72-publisher' ) : __( 'Off (managed posts only)', 'relaunch72-publisher' ) ) : __( 'Owned by the SEO plugin', 'relaunch72-publisher' ),
			__( 'Sitemap', 'relaunch72-publisher' )              => $eval['sitemap']['url'] ? $eval['sitemap']['url'] . ' (' . $eval['sitemap']['owner'] . ')' : __( 'none', 'relaunch72-publisher' ),
			__( 'Capability digest', 'relaunch72-publisher' )    => $caps ? $caps['capabilitiesSha'] : __( 'not advertised while a hold exists', 'relaunch72-publisher' ),
		);
		echo '<table class="widefat striped" style="max-width:960px"><tbody>';
		foreach ( $rows as $k => $v ) {
			echo '<tr><th scope="row" style="width:220px">' . esc_html( $k ) . '</th><td><code>' . esc_html( (string) $v ) . '</code></td></tr>';
		}
		echo '</tbody></table>';
		echo '<h2>' . esc_html__( 'Public output check', 'relaunch72-publisher' ) . '</h2><p>' . esc_html__( 'Fetches your home page, a post, a category archive and the sitemap from the server, as a visitor would, and counts the tags actually served. Caching can delay changes; Relaunch72 separately verifies each article from outside.', 'relaunch72-publisher' ) . '</p>';
		self::form_open( 'public_check' );
		submit_button( __( 'Run public output check', 'relaunch72-publisher' ), 'secondary', 'submit', false );
		echo '</form>';
		$check = get_transient( 'r72pub_public_check' );
		if ( is_array( $check ) ) {
			/* translators: %s: timestamp */
			echo '<p>' . esc_html( sprintf( __( 'Last run %s.', 'relaunch72-publisher' ), $check['at'] ) ) . '</p><table class="widefat striped" style="max-width:1100px"><thead><tr><th>' . esc_html__( 'Page', 'relaunch72-publisher' ) . '</th><th>HTTP</th><th>canonical</th><th>description</th><th>robots</th><th>og:title</th><th>JSON-LD</th><th>' . esc_html__( 'R72 marker', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Cache headers', 'relaunch72-publisher' ) . '</th></tr></thead><tbody>';
			foreach ( $check['pages'] as $kind => $page ) {
				if ( isset( $page['error'] ) ) {
					echo '<tr><td>' . esc_html( $kind ) . '</td><td colspan="8">' . esc_html( $page['error'] ) . '</td></tr>';
					continue;
				}
				$flag = function ( $n, $max = 1 ) {
					return esc_html( (string) $n ) . ( $n > $max ? ' ⚠ ' . esc_html__( 'duplicate', 'relaunch72-publisher' ) : '' );
				};
				echo '<tr><td><a href="' . esc_url( $page['url'] ) . '">' . esc_html( $kind ) . '</a></td><td>' . esc_html( (string) $page['http'] ) . '</td><td>' . $flag( $page['canonical'] ) . ( 0 === $page['canonical'] ? ' ⚠ ' . esc_html__( 'none', 'relaunch72-publisher' ) : '' ) . '</td><td>' . $flag( $page['description'] ) . '</td><td>' . $flag( $page['robots'] ) . '</td><td>' . $flag( $page['ogTitle'] ) . '</td><td>' . esc_html( (string) $page['jsonLd'] ) . '</td><td>' . $flag( $page['r72Marker'] ) . '</td><td><code>' . esc_html( wp_json_encode( $page['cache'] ) ) . '</code></td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $flag escapes.
			}
			echo '</tbody></table>';
			if ( $check['sitemap'] ) {
				echo '<p>' . esc_html__( 'Sitemap', 'relaunch72-publisher' ) . ' <code>' . esc_html( $check['sitemap']['url'] ) . '</code> (' . esc_html( $check['sitemap']['owner'] ) . ') HTTP ' . esc_html( (string) $check['sitemap']['http'] ) . '.</p>';
			}
			echo '<p class="description">' . esc_html__( 'These are observations of what this server returned, not a guarantee of how search engines index the site.', 'relaunch72-publisher' ) . '</p>';
		}
	}

	private static function tab_posts() {
		$q = new WP_Query( array( 'post_type' => 'post', 'post_status' => 'any', 'posts_per_page' => 50, 'meta_key' => R72Pub_Publisher::META_ARTICLE, 'orderby' => 'modified' ) );
		echo '<p>' . esc_html__( 'Posts created by Relaunch72. A post edited in WordPress after Relaunch72 last wrote it is not overwritten unless you allow the next update here. Detaching stops all future updates. Removing the plugin never deletes these posts.', 'relaunch72-publisher' ) . '</p>';
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Post', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Status', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Version', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Manual edit', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'SEO values kept from WordPress edits', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Actions', 'relaunch72-publisher' ) . '</th></tr></thead><tbody>';
		if ( ! $q->posts ) {
			echo '<tr><td colspan="6">' . esc_html__( 'No managed posts yet.', 'relaunch72-publisher' ) . '</td></tr>';
		}
		foreach ( $q->posts as $post ) {
			$edited    = R72Pub_Publisher::manually_edited( $post->ID );
			$detached  = (bool) get_post_meta( $post->ID, R72Pub_Publisher::META_DETACHED, true );
			$allowed   = (bool) get_post_meta( $post->ID, R72Pub_Publisher::META_ALLOW, true );
			$preserved = json_decode( (string) get_post_meta( $post->ID, R72Pub_Seo::META_PRESERVE, true ), true );
			echo '<tr><td><a href="' . esc_url( get_edit_post_link( $post->ID ) ) . '">' . esc_html( get_the_title( $post ) ) . '</a></td><td>' . esc_html( $post->post_status ) . ( $detached ? ' · ' . esc_html__( 'detached', 'relaunch72-publisher' ) : '' ) . '</td><td>' . esc_html( (string) get_post_meta( $post->ID, R72Pub_Publisher::META_NUMBER, true ) ) . '</td><td>' . ( $edited ? ( $allowed ? esc_html__( 'Yes — next update allowed', 'relaunch72-publisher' ) : esc_html__( 'Yes — updates held', 'relaunch72-publisher' ) ) : esc_html__( 'No', 'relaunch72-publisher' ) ) . '</td><td>' . esc_html( is_array( $preserved ) && $preserved ? implode( ', ', $preserved ) : '—' ) . '</td><td>';
			if ( ! $detached ) {
				if ( $edited && ! $allowed ) {
					self::form_open( 'allow' );
					echo '<input type="hidden" name="post_id" value="' . esc_attr( $post->ID ) . '" />';
					submit_button( __( 'Allow next update', 'relaunch72-publisher' ), 'small', 'submit', false );
					echo '</form> ';
				}
				self::form_open( 'detach' );
				echo '<input type="hidden" name="post_id" value="' . esc_attr( $post->ID ) . '" />';
				submit_button( __( 'Detach', 'relaunch72-publisher' ), 'small', 'submit', false, array( 'onclick' => "return confirm('" . esc_js( __( 'Stop Relaunch72 updates for this post? It stays published.', 'relaunch72-publisher' ) ) . "');" ) );
				echo '</form>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function tab_activity() {
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Time (UTC)', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Event', 'relaunch72-publisher' ) . '</th><th>' . esc_html__( 'Detail', 'relaunch72-publisher' ) . '</th></tr></thead><tbody>';
		foreach ( R72Pub_Settings::audit_log() as $row ) {
			echo '<tr><td>' . esc_html( $row['at'] ) . '</td><td>' . esc_html( $row['kind'] ) . '</td><td>' . esc_html( $row['message'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}
}
