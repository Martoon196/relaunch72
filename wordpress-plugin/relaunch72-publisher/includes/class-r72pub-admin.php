<?php
/**
 * Settings → Relaunch72 Publisher. Administrator-only (manage_options), every action
 * nonce-protected, every input sanitised and every output escaped.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Admin {
	const SLUG = 'relaunch72-publisher';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		foreach ( array( 'rotate', 'disconnect', 'pause', 'resume', 'save', 'public_check', 'site_preview', 'site_apply', 'allow', 'detach' ) as $action ) {
			add_action( 'admin_post_r72pub_' . $action, array( __CLASS__, 'handle_' . $action ) );
		}
		add_filter( 'plugin_action_links_' . plugin_basename( R72PUB_FILE ), array( __CLASS__, 'links' ) );
	}

	public static function links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Settings', 'relaunch72-publisher' ) . '</a>' );
		return $links;
	}

	public static function menu() {
		add_options_page( 'Relaunch72 Publisher & SEO', 'Relaunch72 Publisher', 'manage_options', self::SLUG, array( __CLASS__, 'page' ) );
	}

	public static function url( $tab = 'connection', array $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::SLUG, 'tab' => $tab ), $args ), admin_url( 'options-general.php' ) );
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

	private static function form_open( $action ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline">';
		echo '<input type="hidden" name="action" value="' . esc_attr( 'r72pub_' . $action ) . '" />';
		wp_nonce_field( 'r72pub_' . $action );
	}

	// ─── Actions ────────────────────────────────────────────────────────────

	public static function handle_rotate() {
		self::guard( 'rotate' );
		$secret = R72Pub_Settings::rotate_secret();
		// Shown once to this administrator only, then deleted.
		set_transient( 'r72pub_reveal_' . get_current_user_id(), $secret, 600 );
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
		$author   = isset( $_POST['author_id'] ) ? absint( $_POST['author_id'] ) : 0;
		$user     = $author ? get_user_by( 'id', $author ) : false;
		$prefixes = array();
		$raw      = isset( $_POST['media_prefixes'] ) ? sanitize_textarea_field( wp_unslash( $_POST['media_prefixes'] ) ) : '';
		foreach ( preg_split( '/\r\n|\r|\n/', $raw ) as $line ) {
			$line = trim( $line );
			if ( '' !== $line && R72Pub_Settings::valid_media_prefix( $line ) ) {
				$prefixes[] = esc_url_raw( $line );
			}
		}
		$mode = isset( $_POST['seo_mode'] ) ? sanitize_key( wp_unslash( $_POST['seo_mode'] ) ) : 'auto';
		R72Pub_Settings::update(
			array(
				'author_id'         => ( $user && user_can( $user, 'publish_posts' ) ) ? $author : 0,
				'media_prefixes'    => array_slice( array_unique( $prefixes ), 0, 10 ),
				'create_categories' => ! empty( $_POST['create_categories'] ),
				'max_categories'    => isset( $_POST['max_categories'] ) ? max( 0, min( 5, (int) $_POST['max_categories'] ) ) : 3,
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
		$post_id = isset( $_POST['post_id'] ) ? absint( $_POST['post_id'] ) : 0;
		if ( $post_id && get_post_meta( $post_id, R72Pub_Publisher::META_ARTICLE, true ) ) {
			update_post_meta( $post_id, R72Pub_Publisher::META_ALLOW, 1 );
			R72Pub_Settings::audit( 'post.release', 'Post ' . $post_id . ' released for the next Relaunch72 update (manual edits may be replaced).' );
		}
		self::done( 'posts', 'allowed' );
	}

	public static function handle_detach() {
		self::guard( 'detach' );
		$post_id = isset( $_POST['post_id'] ) ? absint( $_POST['post_id'] ) : 0;
		if ( $post_id && get_post_meta( $post_id, R72Pub_Publisher::META_ARTICLE, true ) ) {
			update_post_meta( $post_id, R72Pub_Publisher::META_DETACHED, 1 );
			R72Pub_Settings::audit( 'post.detached', 'Post ' . $post_id . ' detached; Relaunch72 will not update it.' );
		}
		self::done( 'posts', 'detached' );
	}

	/** Proposed site values are held for review, never applied by this step. */
	public static function handle_site_preview() {
		self::guard( 'site_preview' );
		$profiles = array();
		$raw      = isset( $_POST['social_profiles'] ) ? sanitize_textarea_field( wp_unslash( $_POST['social_profiles'] ) ) : '';
		foreach ( preg_split( '/\r\n|\r|\n/', $raw ) as $line ) {
			$line = esc_url_raw( trim( $line ), array( 'https' ) );
			if ( '' !== $line ) {
				$profiles[] = $line;
			}
		}
		$proposal = array(
			'blogname'            => isset( $_POST['blogname'] ) ? sanitize_text_field( wp_unslash( $_POST['blogname'] ) ) : '',
			'blogdescription'     => isset( $_POST['blogdescription'] ) ? sanitize_text_field( wp_unslash( $_POST['blogdescription'] ) ) : '',
			'organization_name'   => isset( $_POST['organization_name'] ) ? sanitize_text_field( wp_unslash( $_POST['organization_name'] ) ) : '',
			'logo_url'            => isset( $_POST['logo_url'] ) ? esc_url_raw( wp_unslash( $_POST['logo_url'] ), array( 'https' ) ) : '',
			'social_profiles'     => array_slice( $profiles, 0, 12 ),
			'title_template'      => isset( $_POST['title_template'] ) ? sanitize_text_field( wp_unslash( $_POST['title_template'] ) ) : '',
			'default_description' => isset( $_POST['default_description'] ) ? sanitize_text_field( wp_unslash( $_POST['default_description'] ) ) : '',
			'apply_templates'     => ! empty( $_POST['apply_templates'] ),
			'organization_schema' => ! empty( $_POST['organization_schema'] ),
		);
		set_transient( 'r72pub_site_proposal_' . get_current_user_id(), $proposal, 1800 );
		self::done( 'site', 'preview' );
	}

	/** Applies only the rows the administrator explicitly ticked on the preview. */
	public static function handle_site_apply() {
		self::guard( 'site_apply' );
		$key      = 'r72pub_site_proposal_' . get_current_user_id();
		$proposal = get_transient( $key );
		$chosen   = isset( $_POST['apply'] ) && is_array( $_POST['apply'] ) ? array_map( 'sanitize_key', wp_unslash( $_POST['apply'] ) ) : array();
		if ( ! is_array( $proposal ) || ! $chosen ) {
			self::done( 'site', 'nothing' );
		}
		$site    = R72Pub_Settings::site_seo();
		$applied = array();
		foreach ( $chosen as $field ) {
			if ( ! array_key_exists( $field, $proposal ) ) {
				continue;
			}
			if ( in_array( $field, array( 'blogname', 'blogdescription' ), true ) ) {
				update_option( $field, $proposal[ $field ] );
			} elseif ( array_key_exists( $field, R72Pub_Settings::site_seo_defaults() ) ) {
				$site[ $field ] = $proposal[ $field ];
			} else {
				continue;
			}
			$applied[] = $field;
		}
		update_option( R72Pub_Settings::OPT_SITE_SEO, $site, false );
		delete_transient( $key );
		R72Pub_Settings::audit( 'site.applied', 'Site settings changed by ' . wp_get_current_user()->user_login . ': ' . implode( ', ', $applied ) . '.' );
		self::done( 'site', 'applied' );
	}

	// ─── Public output check ────────────────────────────────────────────────

	/** Fetch the public page as a visitor would and report what it actually serves. */
	public static function public_check() {
		$managed = get_posts( array( 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids', 'meta_key' => R72Pub_Publisher::META_ARTICLE ) );
		$any     = $managed ? $managed : get_posts( array( 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids' ) );
		$urls    = array( 'home' => home_url( '/' ) );
		if ( $any ) {
			$urls['post'] = get_permalink( $any[0] );
		}
		$sitemap = R72Pub_Seo::sitemap();
		$out     = array( 'at' => gmdate( 'c' ), 'pages' => array(), 'sitemap' => null, 'managed' => (bool) $managed );
		foreach ( $urls as $kind => $url ) {
			$r = wp_remote_get( $url, array( 'timeout' => 15, 'redirection' => 3, 'user-agent' => 'Relaunch72-Publisher-Check/' . R72PUB_VERSION ) );
			if ( is_wp_error( $r ) ) {
				$out['pages'][ $kind ] = array( 'url' => $url, 'error' => 'Could not be fetched from the server itself (loopback). Check from outside with Relaunch72\'s public verification.' );
				continue;
			}
			$html = (string) wp_remote_retrieve_body( $r );
			preg_match( '#<head\b[^>]*>(.*?)</head>#is', $html, $m );
			$head = isset( $m[1] ) ? preg_replace( '#<!--.*?-->#s', '', $m[1] ) : '';
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
						'cache-control'      => wp_remote_retrieve_header( $r, 'cache-control' ),
						'age'                => wp_remote_retrieve_header( $r, 'age' ),
						'x-cache'            => wp_remote_retrieve_header( $r, 'x-cache' ),
						'cf-cache-status'    => wp_remote_retrieve_header( $r, 'cf-cache-status' ),
						'x-proxy-cache'      => wp_remote_retrieve_header( $r, 'x-proxy-cache' ),
						'x-litespeed-cache'  => wp_remote_retrieve_header( $r, 'x-litespeed-cache' ),
					)
				),
			);
		}
		if ( '' !== $sitemap['url'] ) {
			$r              = wp_remote_get( $sitemap['url'], array( 'timeout' => 15, 'redirection' => 0 ) );
			$out['sitemap'] = array(
				'url'   => $sitemap['url'],
				'owner' => $sitemap['owner'],
				'http'  => is_wp_error( $r ) ? 0 : (int) wp_remote_retrieve_response_code( $r ),
			);
		}
		return $out;
	}

	// ─── Page ───────────────────────────────────────────────────────────────

	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'connection'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		$tabs = array( 'connection' => 'Connection', 'diagnostics' => 'Capabilities & diagnostics', 'site' => 'Site SEO', 'posts' => 'Managed posts', 'activity' => 'Activity' );
		echo '<div class="wrap"><h1>Relaunch72 Publisher &amp; SEO</h1>';
		self::notice();
		echo '<nav class="nav-tab-wrapper">';
		foreach ( $tabs as $key => $label ) {
			echo '<a class="nav-tab' . ( $key === $tab ? ' nav-tab-active' : '' ) . '" href="' . esc_url( self::url( $key ) ) . '">' . esc_html( $label ) . '</a>';
		}
		echo '</nav>';
		$method = 'tab_' . ( isset( $tabs[ $tab ] ) ? $tab : 'connection' );
		self::$method();
		echo '</div>';
	}

	private static function notice() {
		$n = isset( $_GET['r72notice'] ) ? sanitize_key( wp_unslash( $_GET['r72notice'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
		$messages = array(
			'key'          => 'A new connection key was created. Any previous key no longer works.',
			'disconnected' => 'Disconnected. The key and brand pairing were removed; published posts were kept.',
			'paused'       => 'Incoming writes are paused. Relaunch72 can still check status and reconcile.',
			'resumed'      => 'Incoming writes resumed.',
			'saved'        => 'Settings saved.',
			'checked'      => 'Public output check finished.',
			'allowed'      => 'The next Relaunch72 update may replace manual edits on that post.',
			'detached'     => 'Post detached. Relaunch72 will not update it again.',
			'preview'      => 'Review the proposed changes below. Nothing has changed yet.',
			'applied'      => 'The selected site settings were applied.',
			'nothing'      => 'No changes were selected, so nothing changed.',
		);
		if ( isset( $messages[ $n ] ) ) {
			echo '<div class="notice notice-info is-dismissible"><p>' . esc_html( $messages[ $n ] ) . '</p></div>';
		}
	}

	private static function versions_row() {
		$wp_ok  = version_compare( get_bloginfo( 'version' ), R72PUB_MIN_WP, '>=' );
		$php_ok = version_compare( PHP_VERSION, R72PUB_MIN_PHP, '>=' );
		echo '<p>Plugin ' . esc_html( R72PUB_VERSION ) . ' · WordPress ' . esc_html( get_bloginfo( 'version' ) ) . ( $wp_ok ? '' : ' (unsupported; needs ' . esc_html( R72PUB_MIN_WP ) . '+)' ) . ' · PHP ' . esc_html( PHP_VERSION ) . ( $php_ok ? '' : ' (unsupported; needs ' . esc_html( R72PUB_MIN_PHP ) . '+)' ) . '. Supported: WordPress ' . esc_html( R72PUB_MIN_WP ) . ' or newer, PHP ' . esc_html( R72PUB_MIN_PHP ) . ' or newer.</p>';
	}

	private static function tab_connection() {
		$settings = R72Pub_Settings::get();
		$pairing  = R72Pub_Settings::pairing();
		$reveal   = get_transient( 'r72pub_reveal_' . get_current_user_id() );
		self::versions_row();
		echo '<h2>1. Connection key</h2>';
		if ( is_string( $reveal ) && '' !== $reveal ) {
			delete_transient( 'r72pub_reveal_' . get_current_user_id() );
			echo '<div class="notice notice-warning inline"><p><strong>Copy this key now; it will not be shown again.</strong> Enter it only in Relaunch72\'s secure website connection form (not in email or chat).</p><p><input type="text" readonly class="large-text code" value="' . esc_attr( $reveal ) . '" onclick="this.select()" /></p></div>';
		}
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row">Status</th><td>' . ( R72Pub_Settings::has_secret() ? 'Key created' : 'No key yet' ) . ( empty( $pairing['brandId'] ) ? ' · not yet paired with a Relaunch72 brand' : ' · paired with Relaunch72 brand <code>' . esc_html( $pairing['brandId'] ) . '</code>, connection <code>' . esc_html( $pairing['destinationId'] ) . '</code>, last check ' . esc_html( $pairing['lastCheckAt'] ?? '' ) ) . '</td></tr>';
		echo '<tr><th scope="row">Site address for Relaunch72</th><td><code>' . esc_html( R72Pub_Capabilities::origin() ) . '</code></td></tr>';
		echo '<tr><th scope="row">Publishing endpoint</th><td><code>' . esc_html( R72Pub_Rest::endpoint() ) . '</code></td></tr>';
		echo '<tr><th scope="row">Site ID</th><td><code>' . esc_html( R72Pub_Settings::site_id() ) . '</code></td></tr>';
		echo '</tbody></table><p>';
		self::form_open( 'rotate' );
		submit_button( R72Pub_Settings::has_secret() ? 'Rotate key (revokes the current key and pairing)' : 'Create connection key', 'primary', 'submit', false );
		echo '</form> ';
		if ( R72Pub_Settings::has_secret() ) {
			self::form_open( 'disconnect' );
			submit_button( 'Disconnect (keeps all posts)', 'secondary', 'submit', false, array( 'onclick' => "return confirm('Disconnect Relaunch72? Published posts stay.');" ) );
			echo '</form>';
		}
		echo '</p><h2>2. Stop switch</h2><p>' . ( $settings['paused'] ? '<strong>Incoming writes are paused.</strong> ' : 'Incoming writes are allowed. ' ) . 'Pausing refuses every new delivery; status checks and reconciliation keep working.</p><p>';
		self::form_open( $settings['paused'] ? 'resume' : 'pause' );
		submit_button( $settings['paused'] ? 'Resume incoming writes' : 'Pause incoming writes', $settings['paused'] ? 'primary' : 'delete', 'submit', false );
		echo '</form></p>';

		echo '<h2>3. Publishing settings</h2>';
		self::form_open( 'save' );
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row"><label for="r72-author">Publish as</label></th><td><select id="r72-author" name="author_id"><option value="0">— Choose a user —</option>';
		foreach ( get_users( array( 'capability' => array( 'publish_posts', 'upload_files' ), 'fields' => array( 'ID', 'display_name', 'user_login' ), 'number' => 200 ) ) as $u ) {
			echo '<option value="' . esc_attr( $u->ID ) . '"' . selected( $settings['author_id'], (int) $u->ID, false ) . '>' . esc_html( $u->display_name . ' (' . $u->user_login . ')' ) . '</option>';
		}
		echo '</select><p class="description">A dedicated Author or Editor account is recommended. Posts appear under this user.</p></td></tr>';
		echo '<tr><th scope="row"><label for="r72-media">Approved image sources</label></th><td><textarea id="r72-media" name="media_prefixes" rows="3" class="large-text code">' . esc_textarea( implode( "\n", $settings['media_prefixes'] ) ) . '</textarea><p class="description">One https prefix per line, ending in "/". Images from anywhere else are refused. Redirects are never followed.</p></td></tr>';
		echo '<tr><th scope="row">Categories</th><td><label><input type="checkbox" name="create_categories" value="1"' . checked( $settings['create_categories'], true, false ) . ' /> Create a missing top-level category named in the owner-approved Relaunch72 structure</label><br /><label>Maximum per article <input type="number" min="0" max="5" name="max_categories" value="' . esc_attr( $settings['max_categories'] ) . '" class="small-text" /></label></td></tr>';
		echo '<tr><th scope="row">SEO mode</th><td><label><input type="radio" name="seo_mode" value="auto"' . checked( $settings['seo_mode'], 'auto', false ) . ' /> Automatic (Yoast SEO, Rank Math or standalone)</label><br /><label><input type="radio" name="seo_mode" value="content_only"' . checked( $settings['seo_mode'], 'content_only', false ) . ' /> Content only: write no SEO values and output no SEO tags</label></td></tr>';
		echo '</tbody></table>';
		submit_button( 'Save settings' );
		echo '</form>';
		echo '<h2>Setup steps</h2><ol><li>Choose the "Publish as" user and save.</li><li>Create a connection key and copy it.</li><li>In Relaunch72: Website connections → WordPress → enter this site address and paste the key into the secure key field → Check connection.</li><li>Review the Capabilities tab here; resolve any hold shown.</li><li>Relaunch72 publishes only owner-approved article versions; this check publishes nothing.</li></ol>';
	}

	private static function tab_diagnostics() {
		$eval = R72Pub_Capabilities::evaluate();
		$caps = R72Pub_Capabilities::capabilities();
		echo '<h2>Readiness</h2>';
		if ( ! $eval['blocking'] ) {
			echo '<p><strong>Ready.</strong> This site can accept Relaunch72 articles.</p>';
		}
		foreach ( $eval['blocking'] as $issue ) {
			echo '<div class="notice notice-error inline"><p><strong>Hold:</strong> ' . esc_html( $issue['message'] ) . '</p></div>';
		}
		foreach ( $eval['warnings'] as $issue ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html( $issue['message'] ) . '</p></div>';
		}
		echo '<table class="widefat striped" style="max-width:960px"><tbody>';
		$rows = array(
			'Permalink structure' => R72Pub_Capabilities::permalink()['structure'] ? R72Pub_Capabilities::permalink()['structure'] : 'Plain',
			'Posts index'         => R72Pub_Capabilities::index()['url'],
			'Article URL pattern' => R72Pub_Capabilities::permalink()['supported'] ? R72Pub_Capabilities::article_pattern() : '—',
			'Category URL pattern' => R72Pub_Capabilities::category_pattern(),
			'SEO owner'           => $eval['seo']['provider'] . ' (' . $eval['seo']['mode'] . ')',
			'SEO detail'          => $eval['seo']['message'],
			'Sitemap'             => $eval['sitemap']['url'] ? $eval['sitemap']['url'] . ' (' . $eval['sitemap']['owner'] . ')' : 'none',
			'Capability digest'   => $caps ? $caps['capabilitiesSha'] : 'not advertised while a hold exists',
		);
		foreach ( $rows as $k => $v ) {
			echo '<tr><th scope="row" style="width:220px">' . esc_html( $k ) . '</th><td><code>' . esc_html( (string) $v ) . '</code></td></tr>';
		}
		echo '</tbody></table>';
		echo '<h2>Public output check</h2><p>Fetches your home page, a post and the sitemap from the server, as a visitor would, and counts the tags actually served. Caching can delay changes; Relaunch72 separately verifies each article from outside.</p>';
		self::form_open( 'public_check' );
		submit_button( 'Run public output check', 'secondary', 'submit', false );
		echo '</form>';
		$check = get_transient( 'r72pub_public_check' );
		if ( is_array( $check ) ) {
			echo '<p>Last run ' . esc_html( $check['at'] ) . '.</p><table class="widefat striped" style="max-width:960px"><thead><tr><th>Page</th><th>HTTP</th><th>canonical</th><th>description</th><th>robots</th><th>og:title</th><th>JSON-LD</th><th>R72 marker</th><th>Cache headers</th></tr></thead><tbody>';
			foreach ( $check['pages'] as $kind => $page ) {
				if ( isset( $page['error'] ) ) {
					echo '<tr><td>' . esc_html( $kind ) . '</td><td colspan="8">' . esc_html( $page['error'] ) . '</td></tr>';
					continue;
				}
				$flag = function ( $n, $max = 1 ) {
					return esc_html( (string) $n ) . ( $n > $max ? ' ⚠ duplicate' : '' );
				};
				echo '<tr><td><a href="' . esc_url( $page['url'] ) . '">' . esc_html( $kind ) . '</a></td><td>' . esc_html( (string) $page['http'] ) . '</td><td>' . $flag( $page['canonical'] ) . ( 0 === $page['canonical'] ? ' ⚠ none' : '' ) . '</td><td>' . $flag( $page['description'] ) . '</td><td>' . $flag( $page['robots'] ) . '</td><td>' . $flag( $page['ogTitle'] ) . '</td><td>' . esc_html( (string) $page['jsonLd'] ) . '</td><td>' . $flag( $page['r72Marker'] ) . '</td><td><code>' . esc_html( wp_json_encode( $page['cache'] ) ) . '</code></td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $flag escapes.
			}
			echo '</tbody></table>';
			if ( $check['sitemap'] ) {
				echo '<p>Sitemap <code>' . esc_html( $check['sitemap']['url'] ) . '</code> (' . esc_html( $check['sitemap']['owner'] ) . ') answered HTTP ' . esc_html( (string) $check['sitemap']['http'] ) . '.</p>';
			}
			echo '<p class="description">These are observations of what this server returned, not a guarantee of how search engines index the site.</p>';
		}
	}

	private static function tab_site() {
		$seo      = R72Pub_Seo::status();
		$site     = R72Pub_Settings::site_seo();
		$proposal = get_transient( 'r72pub_site_proposal_' . get_current_user_id() );
		$current  = array_merge(
			array(
				'blogname'        => get_option( 'blogname' ),
				'blogdescription' => get_option( 'blogdescription' ),
			),
			$site
		);
		echo '<p>' . esc_html( $seo['message'] ) . '</p>';
		if ( in_array( $seo['mode'], array( 'yoast', 'rank_math' ), true ) ) {
			echo '<div class="notice notice-info inline"><p>Site-wide titles, descriptions, social profiles, organisation schema and the sitemap are owned by ' . esc_html( $seo['provider'] ) . '. Change them in that plugin\'s settings; Relaunch72 does not edit another plugin\'s configuration. Only the WordPress site title and tagline below apply.</p></div>';
		}
		if ( is_array( $proposal ) ) {
			echo '<h2>Preview — tick each change to apply</h2>';
			self::form_open( 'site_apply' );
			echo '<table class="widefat striped" style="max-width:960px"><thead><tr><th>Apply</th><th>Setting</th><th>Current</th><th>Proposed</th><th>Effect</th></tr></thead><tbody>';
			$effects = array(
				'blogname'            => 'Site title everywhere WordPress and the theme show it.',
				'blogdescription'     => 'Tagline shown by many themes.',
				'organization_name'   => 'Standalone mode: publisher name in Article schema and Organisation schema.',
				'logo_url'            => 'Standalone mode: publisher logo in schema.',
				'social_profiles'     => 'Standalone mode: sameAs links in Organisation schema on the home page.',
				'title_template'      => 'Standalone mode, if templates are applied: title of every non-managed post and page.',
				'default_description' => 'Standalone mode, if templates are applied: home/blog page meta description.',
				'apply_templates'     => 'Turns the two template rows above on for the whole site.',
				'organization_schema' => 'Standalone mode: outputs Organisation schema on the home page.',
			);
			foreach ( $proposal as $field => $value ) {
				$cur     = $current[ $field ] ?? '';
				$same    = wp_json_encode( $cur ) === wp_json_encode( $value );
				$display = function ( $v ) {
					return is_bool( $v ) ? ( $v ? 'On' : 'Off' ) : ( is_array( $v ) ? implode( "\n", $v ) : (string) $v );
				};
				echo '<tr><td>' . ( $same ? '—' : '<input type="checkbox" name="apply[]" value="' . esc_attr( $field ) . '" />' ) . '</td><td>' . esc_html( $field ) . '</td><td><pre style="white-space:pre-wrap;margin:0">' . esc_html( $display( $cur ) ) . '</pre></td><td><pre style="white-space:pre-wrap;margin:0">' . esc_html( $display( $value ) ) . '</pre></td><td>' . esc_html( $same ? 'No change' : $effects[ $field ] ) . '</td></tr>';
			}
			echo '</tbody></table>';
			if ( ! empty( $proposal['title_template'] ) ) {
				$sample = get_posts( array( 'post_type' => array( 'post', 'page' ), 'post_status' => 'publish', 'posts_per_page' => 3 ) );
				echo '<p><strong>Title template sample:</strong></p><ul>';
				foreach ( $sample as $sp ) {
					echo '<li>' . esc_html( R72Pub_Seo::render_template( $proposal['title_template'], $sp ) ) . '</li>';
				}
				echo '</ul>';
			}
			submit_button( 'Apply selected changes' );
			echo '</form>';
		}
		echo '<h2>Propose site settings</h2><p>Proposals are previewed first. Nothing changes until you tick and apply each row.</p>';
		self::form_open( 'site_preview' );
		echo '<table class="form-table" role="presentation"><tbody>';
		$text = array( 'blogname' => 'Site title', 'blogdescription' => 'Tagline', 'organization_name' => 'Organisation name (schema)', 'logo_url' => 'Logo URL (https)', 'title_template' => 'Title template (%title%, %sitename%, %sep%)', 'default_description' => 'Home/blog meta description' );
		foreach ( $text as $field => $label ) {
			echo '<tr><th scope="row"><label for="r72-' . esc_attr( $field ) . '">' . esc_html( $label ) . '</label></th><td><input type="text" class="regular-text" id="r72-' . esc_attr( $field ) . '" name="' . esc_attr( $field ) . '" value="' . esc_attr( (string) $current[ $field ] ) . '" /></td></tr>';
		}
		echo '<tr><th scope="row"><label for="r72-social">Social profile links</label></th><td><textarea id="r72-social" name="social_profiles" rows="4" class="large-text code">' . esc_textarea( implode( "\n", (array) $current['social_profiles'] ) ) . '</textarea></td></tr>';
		echo '<tr><th scope="row">Standalone output</th><td><label><input type="checkbox" name="apply_templates" value="1"' . checked( ! empty( $current['apply_templates'] ), true, false ) . ' /> Apply title/description templates site-wide</label><br /><label><input type="checkbox" name="organization_schema" value="1"' . checked( ! empty( $current['organization_schema'] ), true, false ) . ' /> Output Organisation schema on the home page</label></td></tr>';
		echo '</tbody></table>';
		submit_button( 'Preview changes', 'secondary' );
		echo '</form>';
	}

	private static function tab_posts() {
		$q = new WP_Query( array( 'post_type' => 'post', 'post_status' => 'any', 'posts_per_page' => 50, 'meta_key' => R72Pub_Publisher::META_ARTICLE, 'orderby' => 'modified' ) );
		echo '<p>Posts created by Relaunch72. A post edited in WordPress after Relaunch72 last wrote it is not overwritten unless you allow the next update here. Detaching stops all future updates. Removing the plugin never deletes these posts.</p>';
		echo '<table class="widefat striped"><thead><tr><th>Post</th><th>Status</th><th>Version</th><th>Manual edit</th><th>SEO values kept from WordPress edits</th><th>Actions</th></tr></thead><tbody>';
		if ( ! $q->posts ) {
			echo '<tr><td colspan="6">No managed posts yet.</td></tr>';
		}
		foreach ( $q->posts as $post ) {
			$edited    = R72Pub_Publisher::manually_edited( $post->ID );
			$detached  = (bool) get_post_meta( $post->ID, R72Pub_Publisher::META_DETACHED, true );
			$allowed   = (bool) get_post_meta( $post->ID, R72Pub_Publisher::META_ALLOW, true );
			$preserved = json_decode( (string) get_post_meta( $post->ID, R72Pub_Seo::META_PRESERVE, true ), true );
			echo '<tr><td><a href="' . esc_url( get_edit_post_link( $post->ID ) ) . '">' . esc_html( get_the_title( $post ) ) . '</a></td><td>' . esc_html( $post->post_status ) . ( $detached ? ' · detached' : '' ) . '</td><td>' . esc_html( (string) get_post_meta( $post->ID, R72Pub_Publisher::META_NUMBER, true ) ) . '</td><td>' . ( $edited ? ( $allowed ? 'Yes — next update allowed' : 'Yes — updates held' ) : 'No' ) . '</td><td>' . esc_html( is_array( $preserved ) && $preserved ? implode( ', ', $preserved ) : '—' ) . '</td><td>';
			if ( ! $detached ) {
				if ( $edited && ! $allowed ) {
					self::form_open( 'allow' );
					echo '<input type="hidden" name="post_id" value="' . esc_attr( $post->ID ) . '" />';
					submit_button( 'Allow next update', 'small', 'submit', false );
					echo '</form> ';
				}
				self::form_open( 'detach' );
				echo '<input type="hidden" name="post_id" value="' . esc_attr( $post->ID ) . '" />';
				submit_button( 'Detach', 'small', 'submit', false, array( 'onclick' => "return confirm('Stop Relaunch72 updates for this post? It stays published.');" ) );
				echo '</form>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function tab_activity() {
		echo '<table class="widefat striped"><thead><tr><th>Time (UTC)</th><th>Event</th><th>Detail</th></tr></thead><tbody>';
		foreach ( R72Pub_Settings::audit_log() as $row ) {
			echo '<tr><td>' . esc_html( $row['at'] ) . '</td><td>' . esc_html( $row['kind'] ) . '</td><td>' . esc_html( $row['message'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}
}
